import { createWorkspacePublicationHttpHandler } from "@jinn-network/benchmark-product-core";
import { readProductServerConfiguration } from "@/lib/server/product-context";

export const dynamic = "force-dynamic";

/** Fixed same-workspace public archive mount. The browser cannot select a workspace. */
async function serve(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  try {
    const { workspaceDir } = readProductServerConfiguration();
    const { path } = await context.params;
    // The core handler owns allow-listing, traversal rejection, exact-byte checks and MIME.
    const pathname = `/${path.map(encodeURIComponent).join("/")}`;
    return createWorkspacePublicationHttpHandler(workspaceDir)(new Request(new URL(pathname, request.url), { method: request.method, headers: request.headers }));
  } catch {
    return new Response(null, { status: 404 });
  }
}

export const GET = serve;
export const HEAD = serve;
