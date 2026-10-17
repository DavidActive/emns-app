# eMNS on AWS (draft)

Prerequisites: a VPC with two public and two private subnets (private subnets need outbound internet or VPC endpoints for ECR, Secrets Manager, CloudWatch Logs), an ACM certificate for the site name, an SMTP service for invitation email, and Terraform 1.6+. Keep Terraform state in an encrypted, access-controlled backend: it contains the secrets you pass in.

1. Build and push two images to ECR: `docker build -t <ecr>/emns:TAG .` and `docker build -f Dockerfile.gateway -t <ecr>/emns-gateway:TAG .`
2. `node scripts/gen-env.cjs` and copy the secrets into a `terraform.tfvars` (never commit it): `jwt_secret`, `anon_key`, `service_role_key`, `worker_secret`, `authenticator_password`, `auth_admin_password`, plus `vpc_id`, subnets, `domain_name`, `certificate_arn`, `app_image`, `gateway_image`, SMTP settings.
3. `terraform init && terraform plan`, review, then `terraform apply`. The first apply creates the database but the service cannot start until step 4 has run (sign-in and the data API need the roles).
4. Run the one-off jobs with the jobs task definition, in this order, overriding the command each time (`bootstrap`, then start the service, then `migrate`, then `seed`):
   `aws ecs run-task --cluster emns --task-definition emns-jobs --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[<private>],securityGroups=[<tasks sg>]}" --overrides '{"containerOverrides":[{"name":"job","command":["node","scripts/db-local.cjs","bootstrap"]}]}'`
   (set `SEED_ADMIN_PASSWORD` in the task environment before running `seed`).
5. Point Twilio and Resend webhooks at `https://<domain>/.netlify/functions/...` and set `TWILIO_WEBHOOK_BASE_URL` to that name.

Real sending stays off (`mock` providers) until you change the provider settings in `main.tf` on purpose.
