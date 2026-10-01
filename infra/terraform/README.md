# Deploying Arbor to AWS

One environment: a VPC, RDS Postgres, an ECS Fargate service behind an ALB, and
the two ECR repositories the `Dockerfile`'s two targets push to. 45 resources.

What this deliberately does **not** provision: S3, SES, SQS, ElastiCache,
Bedrock. The README's platform table lists those because the design
accommodates them; the project's rule is that a managed service arrives when a
feature needs it, with the local implementation written first (D-114). Nothing
needs them yet, and Redis is in the table with nothing using it.

## Prerequisites

- Terraform >= 1.6, the AWS CLI, and Docker.
- Credentials for an account you are willing to bill. **The standing cost is
  not zero** — the NAT gateway (~$32/month), the ALB (~$16/month) and the RDS
  instance run whether or not anyone opens the app. Fargate is the only part
  that tracks `desired_count`.
- `cp terraform.tfvars.example terraform.tfvars` and read it.

## The first deploy, in the order it has to happen

The registries must exist before an image can be pushed, and the service cannot
start without an image. So the first apply is two applies.

```bash
# 1. Registries and everything that does not depend on an image.
terraform init
terraform apply -target=aws_ecr_repository.web -target=aws_ecr_repository.migrator

# 2. Build and push both targets under one tag. Not "latest": the tag is how a
#    rollback is expressed, and the repositories are configured IMMUTABLE so a
#    tag cannot be moved after the fact.
TAG=$(git rev-parse --short HEAD)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=$(terraform output -raw region 2>/dev/null || echo us-east-1)
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

# --platform matters on an Apple Silicon machine: the task definition declares
# X86_64, and an arm64 image fails at start with an exec format error that reads
# like a corrupt image rather than a wrong architecture.
docker build --platform linux/amd64 --target runner   -t "$REGISTRY/arbor-prod-web:$TAG" .
docker build --platform linux/amd64 --target migrator -t "$REGISTRY/arbor-prod-migrator:$TAG" .
docker push "$REGISTRY/arbor-prod-web:$TAG"
docker push "$REGISTRY/arbor-prod-migrator:$TAG"

# 3. Everything else, now that the images exist.
terraform apply -var "image_tag=$TAG"
```

RDS takes about ten minutes to come up on the first apply. The ECS service will
cycle tasks until the schema exists, because `/api/health` asks Postgres a
question — which is the point of it. Run the migration next and it settles.

## Migrations

A one-off task, not a service, and not wired into `terraform apply`: a migration
is a deploy step, and making `apply` perform one would make every `plan` look
like a pending migration.

```bash
aws ecs run-task \
  --cluster "$(terraform output -raw cluster_name)" \
  --task-definition "$(terraform output -raw migrator_task_family)" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
      subnets=[$(terraform output -json private_subnet_ids | jq -r 'join(",")')],
      securityGroups=[$(terraform output -raw tasks_security_group_id)],
      assignPublicIp=DISABLED}"
```

It runs `drizzle-kit migrate` — the same command as `npm run db:migrate`
locally, on purpose. A hand-written runner would be smaller and would be a
second thing deciding what "already applied" means.

Watch it in `/ecs/arbor-prod/migrator`. It exits 0 and stops.

**Ordering.** Migrations here are additive (new tables, new columns, new
indexes), so running them before the new image is serving is safe. The first
migration that removes or narrows something stops being safe in that order, and
that is the point at which this needs an expand/contract rule rather than a
paragraph.

## Deploying a change

```bash
TAG=$(git rev-parse --short HEAD)
# build + push both images as above
aws ecs run-task ...              # only if there are new migrations
terraform apply -var "image_tag=$TAG"
```

`terraform apply` registers a new task definition revision and updates the
service. The deployment circuit breaker is on with `rollback = true`, so an
image that cannot pass its health check returns to the previous revision by
itself instead of cycling until somebody notices.

To roll back deliberately, apply an earlier tag. That works only because the
repositories are immutable and the lifecycle policy keeps the last 20 images.

## What is not done here, and is worth knowing before trusting it

- **No HTTPS until `certificate_arn` is set.** `arbor_session` is a bearer token
  in a cookie (`apps/web/src/server/auth.ts`); over plain HTTP it is readable by
  anything on the path. Fine for proving the deployment works, not for a user.
- **`allowed_ingress_cidrs` defaults to the whole internet.**
- **The database connection is encrypted but unverified.** `sslmode=require`
  with no CA bundle sets `rejectUnauthorized: false` — libpq's meaning of the
  word, and the same posture the app's own `createPool({ ssl: true })` takes. It
  stops a passive listener; it does not stop something that can impersonate the
  database's address inside the VPC. Closing it means shipping the Amazon RDS CA
  bundle in the image and moving to `verify-full`.
- **State is local.** Uncomment the S3 backend in `versions.tf` before a second
  person runs this, and create the lock table with it.
- **One NAT gateway**, so outbound traffic has a single point of failure. It
  carries image pulls and nothing else at present — the app talks only to
  Postgres, inside the VPC.
- **No CI.** Nothing builds or pushes these images automatically, and
  `infra/docker/compose.yml` claims a CI that does not exist.
- **No autoscaling.** `desired_count` is a number somebody sets.
- **Nothing has been applied.** This configuration is `validate`-clean and
  `plan`s to 45 resources; it has never been run against a real account, so
  treat the first apply as the test it is.
