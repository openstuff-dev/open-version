import { Injectable } from '@angular/core';

/**
 * Deploy tokens made a moment ago, by environment id, so the Setup or Keys tab can show each
 * once. Kept in memory only: a reload forgets them, as the server does.
 */
@Injectable({ providedIn: 'root' })
export class FreshTokens {
  private readonly tokens = new Map<string, string>();

  put(environmentId: string, token: string): void {
    this.tokens.set(environmentId, token);
  }

  /** The token, and forget it. */
  take(environmentId: string): string | null {
    const token = this.tokens.get(environmentId) ?? null;
    this.tokens.delete(environmentId);
    return token;
  }
}
