// The app:// scheme that serves the dashboard from dist/renderer. Only type
// imports from 'electron' so the request handler is unit-testable.

import { readFile } from 'node:fs/promises';
import type { CustomScheme, Protocol } from 'electron';
import type { Logger } from '../service/contracts';
import { APP_SCHEME, RENDERER_CSP, resolveAppRequest } from './paths';

/** Must be registered before app 'ready'. */
export const APP_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
};

export interface AppRequestHandlerOptions {
  rootDir: string;
  readFile?: (filePath: string) => Promise<Uint8Array>;
  csp?: string;
  log?: Pick<Logger, 'warn'>;
}

function baseHeaders(csp: string): Record<string, string> {
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
  };
}

function textResponse(status: number, body: string, csp: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...baseHeaders(csp), 'Content-Type': 'text/plain; charset=utf-8', ...extra },
  });
}

export function createAppRequestHandler(opts: AppRequestHandlerOptions): (request: Request) => Promise<Response> {
  const read = opts.readFile ?? ((p: string) => readFile(p));
  const csp = opts.csp ?? RENDERER_CSP;

  return async (request) => {
    const resolved = resolveAppRequest(opts.rootDir, request.url, request.method);
    if (!resolved.ok) {
      if (resolved.status === 403 || resolved.status === 400) {
        opts.log?.warn(`app:// request refused (${resolved.reason})`, { url: request.url.slice(0, 300) });
      }
      if (resolved.status === 405) return textResponse(405, 'Method not allowed', csp, { Allow: 'GET' });
      return textResponse(resolved.status, resolved.status === 404 ? 'Not found' : 'Forbidden', csp);
    }
    let body: Uint8Array;
    try {
      body = await read(resolved.filePath);
    } catch {
      // Missing files and directories (EISDIR) both end here.
      return textResponse(404, 'Not found', csp);
    }
    return new Response(body as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: { ...baseHeaders(csp), 'Content-Type': resolved.mimeType, 'Content-Length': String(body.byteLength) },
    });
  };
}

/** Installs the handler on the default session. Call after app 'ready'. */
export function registerAppProtocol(protocol: Pick<Protocol, 'handle'>, rootDir: string, log: Logger): void {
  protocol.handle(APP_SCHEME, createAppRequestHandler({ rootDir, log }));
}
