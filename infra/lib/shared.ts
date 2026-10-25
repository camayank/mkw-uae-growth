import * as path from "path";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";

/** The repository root: the Docker build context for the image (the repository's own Dockerfile, unchanged). */
export const REPO_ROOT = path.resolve(__dirname, "../../..");

/** The platform image, built from the Dockerfile at deploy time and pushed to the account's ECR in the region. */
export function platformImage(): ecs.ContainerImage {
  return ecs.ContainerImage.fromAsset(REPO_ROOT, { platform: Platform.LINUX_AMD64 });
}

/** UAE region for everything that holds client data (UAE PDPL). */
export const REGION = "me-central-1";

/**
 * The container builds DATABASE_URL from the RDS secret's parts at start, verified against the RDS certificate
 * authorities baked into the image. The generated password excludes every character that would need URL encoding.
 */
export function withDatabaseUrl(cmd: string): string[] {
  return [
    "sh",
    "-c",
    `export DATABASE_URL="postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME?sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-global-bundle.pem" && exec ${cmd}`,
  ];
}

/** Characters left out of the generated database password so it can sit in a URL unencoded. */
export const DB_PASSWORD_EXCLUDE = " %+~`#$&*()|[]{}:;<>?!'/@\"\\=,^.";

export function required(value: string | undefined, name: string): string {
  if (!value || /REPLACE|CHANGE_ME/i.test(value)) throw new Error(`Context value "${name}" is required: pass -c ${name}=... (see docs/DEPLOY.md, Staging runbook)`);
  return value;
}
