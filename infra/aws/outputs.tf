output "site_url" { value = "https://${var.domain_name}" }
output "alb_dns_name" { value = aws_lb.alb.dns_name }
output "cluster" { value = aws_ecs_cluster.c.name }
output "jobs_task_definition" { value = aws_ecs_task_definition.jobs.family }
output "db_endpoint" { value = aws_db_instance.db.address }
output "private_subnets_for_jobs" { value = var.private_subnet_ids }
output "tasks_security_group" { value = aws_security_group.tasks.id }
