import { z } from "zod/v4";

export interface OpenApiRouteSpec {
  path: string;
  method: "get";
  summary: string;
  responseSchema: z.ZodType;
}

export interface OpenApiDocumentInput {
  info: { title: string; version: string; description?: string };
  routes: readonly OpenApiRouteSpec[];
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
}

export function buildOpenApiDocument(input: OpenApiDocumentInput): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const route of input.routes) {
    const jsonSchema = toJsonSchema(route.responseSchema);
    paths[route.path] = {
      [route.method]: {
        summary: route.summary,
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: jsonSchema },
            },
          },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: input.info,
    paths,
  };
}
