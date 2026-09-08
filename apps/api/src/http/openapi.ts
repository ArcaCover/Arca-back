import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ScanResponse, PollResponse } from './schemas.js';
extendZodWithOpenApi(z);
export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'sessionToken', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  const error = z.object({ error: z.string(), message: z.string() }).strict();
  const json = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });
  registry.registerPath({ method: 'post', path: '/scan', summary: 'Start a domain scan or reuse fresh evidence',
    request: { body: { required: true, content: json(z.object({ email: z.string().email(), domain: z.string().optional() }).strict()) } },
    responses: {
      202: { description: 'Scan started', content: json(ScanResponse) },
      200: { description: 'Cached assessment, or UNRESOLVED with canonicalDomain null and assessment null', content: json(ScanResponse) },
      400: { description: 'Invalid request', content: json(error) },
      429: { description: '10 requests per IP/hour or 3 per email/hour exceeded', content: json(error), headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until retry' } } },
      500: { description: 'Persistence or internal failure', content: json(error) },
    } });
  registry.registerPath({ method: 'get', path: '/scan/{scanId}', summary: 'Poll scan status',
    security: [{ sessionToken: [] }], request: { params: z.object({ scanId: z.string() }) },
    responses: { 200: { description: 'RUNNING, COMPLETED, PARTIAL or FAILED. All but RUNNING are terminal.', content: json(PollResponse) },
      401: { description: 'Missing or invalid session', content: json(error) },
      404: { description: 'Scan not found', content: json(error) },
      500: { description: 'Internal failure', content: json(error) } } });
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({ openapi: '3.1.0',
    info: { title: 'ARCA Layer 1 API', version: '1.0.0', description: 'Domain evidence scoring. Null represents unavailable evidence; tier and decision are separate. Never interpret unknown signals as false or zero.' } });
}
