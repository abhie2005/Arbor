/**
 * Two repositories, because the Dockerfile has two targets.
 *
 * One repository with two tag prefixes would work and would make "delete
 * untagged images older than N days" a rule that cannot tell the app apart from
 * the migrator. Two repositories keep the lifecycle policies independent, which
 * matters because they want opposite things: app images are worth keeping for
 * rollback, migration images are disposable the moment the task exits.
 */

resource "aws_ecr_repository" "web" {
  name = "${local.name}-web"

  # Immutable tags, because `var.image_tag` is a commit sha and a rollback is
  # only expressible if the thing being rolled back to still exists. A mutable
  # tag turns "deploy the previous sha" into "deploy whatever that sha points at
  # now", which is the same push that broke it.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "migrator" {
  name                 = "${local.name}-migrator"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "web" {
  repository = aws_ecr_repository.web.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 20 images; a rollback never reaches further back than that"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "migrator" {
  repository = aws_ecr_repository.migrator.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Migration images are disposable once the task has run"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}
