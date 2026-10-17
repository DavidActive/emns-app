variable "region" {
  type    = string
  default = "us-east-1"
}
variable "name" {
  type    = string
  default = "emns"
}
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "private_subnet_ids" { type = list(string) }

variable "domain_name" {
  description = "Public name for the site, for example emns.activesos.com"
  type        = string
}
variable "certificate_arn" {
  description = "ACM certificate (same region) covering domain_name"
  type        = string
}
variable "route53_zone_id" {
  description = "Hosted zone for domain_name. Leave empty to create the DNS record yourself."
  type        = string
  default     = ""
}

variable "app_image" {
  description = "ECR image URI (with tag) for the eMNS app, built from the Dockerfile"
  type        = string
}
variable "gateway_image" {
  description = "ECR image URI (with tag) for the front door, built from Dockerfile.gateway"
  type        = string
}
variable "postgrest_image" {
  type    = string
  default = "postgrest/postgrest:v12.2.12"
}
variable "gotrue_image" {
  type    = string
  default = "supabase/gotrue:v2.174.0"
}

variable "task_cpu" {
  type    = number
  default = 1024
}
variable "task_memory" {
  type    = number
  default = 2048
}
variable "desired_count" {
  type    = number
  default = 2
}
variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "db_multi_az" {
  type    = bool
  default = true
}
variable "db_allocated_storage" {
  type    = number
  default = 50
}
variable "waf_rate_limit_per_5min" {
  description = "Requests per client address per 5 minutes before the web firewall blocks it"
  type        = number
  default     = 2000
}

# Secrets. Generate with: node scripts/gen-env.cjs (then copy the values). They are stored in AWS Secrets Manager.
# They also appear in Terraform state, so keep state in an encrypted, access-controlled backend.
variable "jwt_secret" {
  type      = string
  sensitive = true
}
variable "anon_key" {
  type      = string
  sensitive = true
}
variable "service_role_key" {
  type      = string
  sensitive = true
}
variable "worker_secret" {
  type      = string
  sensitive = true
}
variable "authenticator_password" {
  type      = string
  sensitive = true
}
variable "auth_admin_password" {
  type      = string
  sensitive = true
}
variable "smtp_host" {
  description = "Mail server GoTrue uses for staff and employee invitations"
  type        = string
}
variable "smtp_port" {
  type    = number
  default = 587
}
variable "smtp_user" {
  type    = string
  default = ""
}
variable "smtp_password" {
  type      = string
  sensitive = true
  default   = ""
}
variable "smtp_admin_email" {
  type = string
}
