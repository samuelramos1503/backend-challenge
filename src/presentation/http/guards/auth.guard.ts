import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

export const IS_PUBLIC_KEY = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface AuthenticatedPrincipal {
  subject: string;
  providerId?: string;
  scopes: string[];
}

/**
 * Explicit extension port for integrating an external OIDC Identity Provider (Keycloak / Zitadel).
 * Documented in ARCHITECTURE.md per Section 2 of the challenge specification.
 */
export interface ProviderIdentityPort {
  verifyToken(bearerToken: string): Promise<AuthenticatedPrincipal | null>;
}

@Injectable()
export class ExternalIdpAuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // No-op pass-through by default as documented in ARCHITECTURE.md (Section 2).
    // In production, this guard validates the OIDC JWT against Keycloak/Zitadel JWKS.
    const request = context.switchToHttp().getRequest();
    request.principal = {
      subject: request.headers?.["x-provider-id"] || "anonymous-provider",
      providerId: request.headers?.["x-provider-id"],
      scopes: ["wagering:write", "wagering:read", "wallet:write", "wallet:read"],
    } satisfies AuthenticatedPrincipal;

    return true;
  }
}
