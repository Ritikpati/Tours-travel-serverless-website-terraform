terraform {
  required_version = ">= 1.10"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {
    bucket       = "tours-tfstate-288839812643"
    key          = "tours/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
  }
}