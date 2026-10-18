interface OpenApiOperation {
  summary?: string;
  parameters?: unknown;
  requestBody?: unknown;
  responses?: unknown;
}
interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, unknown> };
}
const element = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) throw new Error('Missing element: ' + id);
  return found;
};
fetch('/openapi.json')
  .then(async (r) => (await r.json()) as OpenApiDocument)
  .then((schema) => {
    for (const [path, methods] of Object.entries(schema.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const section = document.createElement('details');
        section.className = 'panel methodology';
        const summary = document.createElement('summary');
        summary.textContent = `${method.toUpperCase()} ${path} · ${operation.summary || ''}`;
        section.append(summary);
        const pre = document.createElement('pre');
        pre.className = 'schema-code';
        pre.textContent = JSON.stringify(
          {
            parameters: operation.parameters,
            requestBody: operation.requestBody,
            responses: operation.responses,
          },
          null,
          2,
        );
        section.append(pre);
        element('api-paths').append(section);
      }
    }
    for (const [name, definition] of Object.entries(schema.components?.schemas || {})) {
      const section = document.createElement('details');
      section.className = 'panel methodology';
      const summary = document.createElement('summary');
      summary.textContent = name;
      section.append(summary);
      const pre = document.createElement('pre');
      pre.className = 'schema-code';
      pre.textContent = JSON.stringify(definition, null, 2);
      section.append(pre);
      element('api-schemas').append(section);
    }
  })
  .catch(() => {
    element('api-paths').textContent = 'Не удалось загрузить схему API.';
  });
