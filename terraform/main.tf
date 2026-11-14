terraform {
  required_version = ">= 1.10"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {
    # bucket is passed at init time (-backend-config)
    key          = "tours/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "me" {}
data "aws_route53_zone" "z" {
  name = var.zone_name
}
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

locals {
  user_bucket  = "${var.subdomain}.${var.zone_name}"
  admin_bucket = "${var.prefix}-tours-admin-${data.aws_caller_identity.me.account_id}"

  tables = {
    Users    = "email"
    Admins   = "username"
    Packages = "packageId"
    Payments = "paymentId"
  }

  lambdas = {
    "tours-auth"     = ["POST /register", "POST /login", "POST /admin/login"]
    "tours-packages" = ["GET /packages", "POST /admin/package", "DELETE /admin/package"]
    "tours-booking"  = ["POST /book", "POST /pay", "GET /mybookings", "POST /cancel"]
    "tours-admin"    = ["GET /admin/summary", "POST /admin/payment", "DELETE /admin/payment"]
  }
  routes = merge([for fn, rs in local.lambdas : { for r in rs : r => fn }]...)

  packages = {
    PK1001 = { name = "Goa Beach Tour", destination = "Goa", days = 4, price = 15000, image = "" }
    PK1002 = { name = "Bali Island Tour", destination = "Bali", days = 5, price = 40000, image = "" }
    PK1003 = { name = "Dubai City Tour", destination = "Dubai", days = 5, price = 50000, image = "" }
    PK1004 = { name = "Kerala Backwaters", destination = "Kerala", days = 5, price = 18000, image = "" }
    PK1005 = { name = "Manali Snow Trip", destination = "Manali", days = 4, price = 12000, image = "" }
    PK1006 = { name = "Jaipur Heritage Tour", destination = "Jaipur", days = 3, price = 10000, image = "" }
    PK1007 = {
      name = "Puri Jagannath Tour", destination = "Puri", days = 3, price = 9000,
      image = "https://images.pexels.com/photos/27023262/pexels-photo-27023262/free-photo-of-jagannath-temple-in-puri-in-india.jpeg?auto=compress&cs=tinysrgb&w=1600"
    }
  }
}

# ---------------- DynamoDB ----------------
resource "aws_dynamodb_table" "t" {
  for_each     = local.tables
  name         = each.key
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = each.value
  attribute {
    name = each.value
    type = "S"
  }
}

resource "aws_dynamodb_table_item" "admin" {
  table_name = aws_dynamodb_table.t["Admins"].name
  hash_key   = "username"
  item = jsonencode({
    username     = { S = "admin" }
    passwordHash = { S = var.admin_password_hash }
  })
}

resource "aws_dynamodb_table_item" "pkg" {
  for_each   = var.seed_packages ? local.packages : {}
  table_name = aws_dynamodb_table.t["Packages"].name
  hash_key   = "packageId"
  item = jsonencode({
    packageId   = { S = each.key }
    name        = { S = each.value.name }
    destination = { S = each.value.destination }
    days        = { N = tostring(each.value.days) }
    price       = { N = tostring(each.value.price) }
    image       = { S = each.value.image }
  })
  lifecycle {
    ignore_changes = [item]
  }
}

# ---------------- IAM + Lambda ----------------
resource "random_password" "secret" {
  length  = 40
  special = false
}

resource "aws_iam_role" "lambda" {
  name = "${var.prefix}-tours-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "ddb" {
  name = "dynamodb-access"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan", "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:Query"]
      Resource = [for t in aws_dynamodb_table.t : t.arn]
    }]
  })
}

data "archive_file" "zip" {
  for_each    = local.lambdas
  type        = "zip"
  source_file = "${path.module}/../lambdas/${each.key}/index.mjs"
  output_path = "${path.module}/build/${each.key}.zip"
}

resource "aws_lambda_function" "fn" {
  for_each         = local.lambdas
  function_name    = "${var.prefix}-${each.key}"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  timeout          = 10
  filename         = data.archive_file.zip[each.key].output_path
  source_code_hash = data.archive_file.zip[each.key].output_base64sha256
  environment {
    variables = {
      SECRET = random_password.secret.result
      UPI_ID = var.upi_id
    }
  }
}

# ---------------- API Gateway (two separate APIs: user + admin) ----------------
locals {
  admin_routes = { for r, fn in local.routes : r => fn if startswith(split(" ", r)[1], "/admin/") }
  user_routes  = { for r, fn in local.routes : r => fn if !startswith(split(" ", r)[1], "/admin/") }

  route_list = merge(
    { for r, fn in local.user_routes : "user|${r}" => { api = "user", key = r, fn = fn } },
    { for r, fn in local.admin_routes : "admin|${r}" => { api = "admin", key = r, fn = fn } }
  )
  # one integration per (api, lambda) pair that is actually used
  integ = {
    for v in distinct([for k, x in local.route_list : "${x.api}|${x.fn}"]) :
    v => { api = split("|", v)[0], fn = split("|", v)[1] }
  }
  # the admin API only accepts calls from the admin website (CloudFront); the user API is open
  cors_origins = {
    user  = ["*"]
    admin = ["https://${aws_cloudfront_distribution.admin.domain_name}"]
  }
}

resource "aws_apigatewayv2_api" "api" {
  for_each      = toset(["user", "admin"])
  name          = "${var.prefix}-tours-${each.key}-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = local.cors_origins[each.key]
    allow_methods = ["GET", "POST", "DELETE", "OPTIONS"]
    allow_headers = ["content-type", "authorization"]
  }
}

resource "aws_apigatewayv2_stage" "default" {
  for_each    = aws_apigatewayv2_api.api
  api_id      = each.value.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_apigatewayv2_integration" "i" {
  for_each               = local.integ
  api_id                 = aws_apigatewayv2_api.api[each.value.api].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.fn[each.value.fn].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "r" {
  for_each  = local.route_list
  api_id    = aws_apigatewayv2_api.api[each.value.api].id
  route_key = each.value.key
  target    = "integrations/${aws_apigatewayv2_integration.i["${each.value.api}|${each.value.fn}"].id}"
}

resource "aws_lambda_permission" "apigw" {
  for_each      = local.integ
  statement_id  = "AllowAPIGateway-${each.value.api}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.value.fn].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api[each.value.api].execution_arn}/*/*"
}

# ---------------- User site: S3 website + Route 53 ----------------
resource "aws_s3_bucket" "user" {
  bucket        = local.user_bucket
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "user" {
  bucket                  = aws_s3_bucket.user.id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_website_configuration" "user" {
  bucket = aws_s3_bucket.user.id
  index_document {
    suffix = "index.html"
  }
}

resource "aws_s3_bucket_policy" "user" {
  bucket     = aws_s3_bucket.user.id
  depends_on = [aws_s3_bucket_public_access_block.user]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.user.arn}/*"
    }]
  })
}

resource "aws_route53_record" "user" {
  zone_id = data.aws_route53_zone.z.zone_id
  name    = local.user_bucket
  type    = "A"
  alias {
    name                   = aws_s3_bucket_website_configuration.user.website_domain
    zone_id                = aws_s3_bucket.user.hosted_zone_id
    evaluate_target_health = false
  }
}

# ---------------- Admin site: private S3 + CloudFront ----------------
resource "aws_s3_bucket" "admin" {
  bucket        = local.admin_bucket
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "admin" {
  bucket                  = aws_s3_bucket.admin.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "oac" {
  name                              = "${var.prefix}-tours-admin-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "admin" {
  enabled             = true
  default_root_object = "index.html"
  origin {
    domain_name              = aws_s3_bucket.admin.bucket_regional_domain_name
    origin_id                = "admin"
    origin_access_control_id = aws_cloudfront_origin_access_control.oac.id
  }
  default_cache_behavior {
    target_origin_id       = "admin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.disabled.id
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_s3_bucket_policy" "admin" {
  bucket = aws_s3_bucket.admin.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.admin.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.admin.arn } }
    }]
  })
}
