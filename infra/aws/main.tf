# eMNS on AWS: one Fargate service (gateway + app + scheduler + data API + sign-in containers sharing a network namespace),
# RDS PostgreSQL, an HTTPS load balancer with a web firewall, and Secrets Manager. DRAFT: review, plan and test in a non-production account first.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
}
provider "aws" { region = var.region }

locals {
  tags      = { Application = "emns", ManagedBy = "terraform" }
  db_host   = aws_db_instance.db.address
  pub_url   = "https://${var.domain_name}"
  mock_env  = [ # real sending stays off until you change these deliberately
    { name = "EMNS_MESSAGE_PROVIDER", value = "mock" },
    { name = "EMNS_EMAIL_PROVIDER", value = "mock" },
    { name = "EMNS_VOICE_PROVIDER", value = "mock" },
    { name = "EMNS_ALLOW_REAL_SEND", value = "false" },
  ]
}

# ---------- Network access ----------
resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  vpc_id      = var.vpc_id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}
resource "aws_security_group" "tasks" {
  name_prefix = "${var.name}-tasks-"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}
resource "aws_security_group" "db" {
  name_prefix = "${var.name}-db-"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
  tags = local.tags
}

# ---------- Database ----------
resource "aws_db_subnet_group" "db" {
  name       = "${var.name}-db"
  subnet_ids = var.private_subnet_ids
  tags       = local.tags
}
resource "aws_db_instance" "db" {
  identifier                      = "${var.name}-db"
  engine                          = "postgres"
  engine_version                  = "16"
  instance_class                  = var.db_instance_class
  allocated_storage               = var.db_allocated_storage
  storage_encrypted               = true
  multi_az                        = var.db_multi_az
  db_name                         = "postgres"
  username                        = "postgres"
  manage_master_user_password     = true
  db_subnet_group_name            = aws_db_subnet_group.db.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  backup_retention_period         = 14
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.name}-db-final"
  auto_minor_version_upgrade      = true
  enabled_cloudwatch_logs_exports = ["postgresql"]
  tags                            = local.tags
}

# ---------- Secrets ----------
locals {
  secrets = {
    JWT_SECRET             = var.jwt_secret
    ANON_KEY               = var.anon_key
    SERVICE_ROLE_KEY       = var.service_role_key
    EMNS_WORKER_SECRET     = var.worker_secret
    AUTHENTICATOR_PASSWORD = var.authenticator_password
    AUTH_ADMIN_PASSWORD    = var.auth_admin_password
    PGRST_DB_URI           = "postgres://authenticator:${var.authenticator_password}@${local.db_host}:5432/postgres"
    GOTRUE_DB_DATABASE_URL = "postgres://supabase_auth_admin:${var.auth_admin_password}@${local.db_host}:5432/postgres"
    SMTP_PASSWORD          = var.smtp_password == "" ? "unused" : var.smtp_password
  }
}
resource "aws_secretsmanager_secret" "s" {
  for_each                = local.secrets
  name                    = "${var.name}/${each.key}"
  recovery_window_in_days = 7
  tags                    = local.tags
}
resource "aws_secretsmanager_secret_version" "s" {
  for_each      = local.secrets
  secret_id     = aws_secretsmanager_secret.s[each.key].id
  secret_string = each.value
}

# ---------- Logs and roles ----------
resource "aws_cloudwatch_log_group" "logs" {
  name              = "/ecs/${var.name}"
  retention_in_days = 365
  tags              = local.tags
}
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}
resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = concat([for s in aws_secretsmanager_secret.s : s.arn], [aws_db_instance.db.master_user_secret[0].secret_arn])
  }
}
resource "aws_iam_role_policy" "execution_secrets" {
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_secrets.json
}
resource "aws_iam_role" "task" { # the app needs no AWS permissions
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

# ---------- Cluster and the main task ----------
resource "aws_ecs_cluster" "c" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

locals {
  log = { logDriver = "awslogs", options = { "awslogs-group" = aws_cloudwatch_log_group.logs.name, "awslogs-region" = var.region } }
  sec = { for k, v in aws_secretsmanager_secret.s : k => v.arn }
  app_env = concat(local.mock_env, [
    { name = "SUPABASE_URL", value = "http://localhost" },
    { name = "EMNS_BASE_URL", value = local.pub_url },
    { name = "TWILIO_WEBHOOK_BASE_URL", value = local.pub_url },
    { name = "EMNS_INTERNAL_URL", value = "http://localhost:8080" },
    { name = "EMNS_PUBLIC_SUPABASE_URL", value = local.pub_url },
    { name = "EMNS_ENV", value = "production" },
  ])
  app_secrets = [
    { name = "SUPABASE_SERVICE_ROLE_KEY", valueFrom = local.sec["SERVICE_ROLE_KEY"] },
    { name = "EMNS_WORKER_SECRET", valueFrom = local.sec["EMNS_WORKER_SECRET"] },
  ]
}

resource "aws_ecs_task_definition" "main" {
  family                   = "${var.name}-main"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([
    {
      name = "gateway", image = var.gateway_image, essential = true, logConfiguration = local.log
      portMappings = [{ containerPort = 80 }]
      environment  = [{ name = "UPSTREAM_APP", value = "localhost:8080" }, { name = "UPSTREAM_REST", value = "localhost:3000" }, { name = "UPSTREAM_AUTH", value = "localhost:9999" }]
    },
    {
      name = "app", image = var.app_image, essential = true, logConfiguration = local.log
      environment = concat(local.app_env, [{ name = "PORT", value = "8080" }])
      secrets     = concat(local.app_secrets, [{ name = "EMNS_PUBLIC_SUPABASE_KEY", valueFrom = local.sec["ANON_KEY"] }])
    },
    {
      name = "scheduler", image = var.app_image, essential = true, logConfiguration = local.log
      command     = ["node", "server/worker.cjs"]
      environment = concat(local.app_env, [{ name = "EMNS_SWEEP_SECONDS", value = "15" }])
      secrets     = local.app_secrets
    },
    {
      name = "rest", image = var.postgrest_image, essential = true, logConfiguration = local.log
      environment = [{ name = "PGRST_DB_SCHEMAS", value = "public" }, { name = "PGRST_DB_ANON_ROLE", value = "anon" }, { name = "PGRST_DB_USE_LEGACY_GUCS", value = "false" }]
      secrets     = [{ name = "PGRST_DB_URI", valueFrom = local.sec["PGRST_DB_URI"] }, { name = "PGRST_JWT_SECRET", valueFrom = local.sec["JWT_SECRET"] }]
    },
    {
      name = "auth", image = var.gotrue_image, essential = true, logConfiguration = local.log
      environment = [
        { name = "GOTRUE_API_HOST", value = "0.0.0.0" }, { name = "GOTRUE_API_PORT", value = "9999" },
        { name = "API_EXTERNAL_URL", value = "${local.pub_url}/auth/v1" }, { name = "GOTRUE_DB_DRIVER", value = "postgres" },
        { name = "GOTRUE_SITE_URL", value = local.pub_url }, { name = "GOTRUE_URI_ALLOW_LIST", value = "${local.pub_url}/**" },
        { name = "GOTRUE_DISABLE_SIGNUP", value = "true" }, { name = "GOTRUE_JWT_EXP", value = "3600" }, { name = "GOTRUE_JWT_DEFAULT_GROUP_NAME", value = "authenticated" },
        { name = "GOTRUE_MAILER_AUTOCONFIRM", value = "false" }, { name = "GOTRUE_SMTP_HOST", value = var.smtp_host }, { name = "GOTRUE_SMTP_PORT", value = tostring(var.smtp_port) },
        { name = "GOTRUE_SMTP_USER", value = var.smtp_user }, { name = "GOTRUE_SMTP_ADMIN_EMAIL", value = var.smtp_admin_email },
        { name = "GOTRUE_MAILER_URLPATHS_INVITE", value = "/auth/v1/verify" }, { name = "GOTRUE_MAILER_URLPATHS_RECOVERY", value = "/auth/v1/verify" },
      ]
      secrets = [
        { name = "GOTRUE_DB_DATABASE_URL", valueFrom = local.sec["GOTRUE_DB_DATABASE_URL"] },
        { name = "GOTRUE_JWT_SECRET", valueFrom = local.sec["JWT_SECRET"] },
        { name = "GOTRUE_SMTP_PASS", valueFrom = local.sec["SMTP_PASSWORD"] },
      ]
    },
  ])
  tags = local.tags
}

# One-off jobs (run with aws ecs run-task): override the command to bootstrap, migrate or seed. See infra/aws/README.md.
resource "aws_ecs_task_definition" "jobs" {
  family                   = "${var.name}-jobs"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([
    {
      name = "job", image = var.app_image, essential = true, logConfiguration = local.log
      command = ["node", "scripts/db-local.cjs", "migrate"]
      environment = [{ name = "PGHOST", value = local.db_host }, { name = "PGDATABASE", value = "postgres" }, { name = "PGSSLMODE", value = "require" }, { name = "SUPABASE_URL", value = local.pub_url }, { name = "SEED_ADMIN_EMAIL", value = "admin@example.com" }]
      secrets = [
        { name = "PGUSER", valueFrom = "${aws_db_instance.db.master_user_secret[0].secret_arn}:username::" },
        { name = "PGPASSWORD", valueFrom = "${aws_db_instance.db.master_user_secret[0].secret_arn}:password::" },
        { name = "AUTHENTICATOR_PASSWORD", valueFrom = local.sec["AUTHENTICATOR_PASSWORD"] },
        { name = "AUTH_ADMIN_PASSWORD", valueFrom = local.sec["AUTH_ADMIN_PASSWORD"] },
        { name = "SUPABASE_SERVICE_ROLE_KEY", valueFrom = local.sec["SERVICE_ROLE_KEY"] },
      ]
    },
  ])
  tags = local.tags
}

resource "aws_ecs_service" "main" {
  name            = "${var.name}-main"
  cluster         = aws_ecs_cluster.c.id
  task_definition = aws_ecs_task_definition.main.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [aws_security_group.tasks.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.tg.arn
    container_name   = "gateway"
    container_port   = 80
  }
  depends_on = [aws_lb_listener.https]
  tags       = local.tags
}

# ---------- Load balancer, HTTPS, firewall, DNS ----------
resource "aws_lb" "alb" {
  name                       = "${var.name}-alb"
  load_balancer_type         = "application"
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  tags                       = local.tags
}
resource "aws_lb_target_group" "tg" {
  name        = "${var.name}-tg"
  port        = 80
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path    = "/healthz"
    matcher = "200"
  }
  tags = local.tags
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.alb.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.tg.arn
  }
}
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.alb.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_wafv2_web_acl" "acl" {
  name  = "${var.name}-acl"
  scope = "REGIONAL"
  default_action {
    allow {}
  }
  rule {
    name     = "per-address-rate"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit_per_5min
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate"
      sampled_requests_enabled   = true
    }
  }
  rule {
    name     = "aws-common"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-common"
      sampled_requests_enabled   = true
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-acl"
    sampled_requests_enabled   = true
  }
  tags = local.tags
}
resource "aws_wafv2_web_acl_association" "assoc" {
  resource_arn = aws_lb.alb.arn
  web_acl_arn  = aws_wafv2_web_acl.acl.arn
}

resource "aws_route53_record" "dns" {
  count   = var.route53_zone_id == "" ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_lb.alb.dns_name
    zone_id                = aws_lb.alb.zone_id
    evaluate_target_health = true
  }
}
