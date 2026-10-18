'use strict';
fetch('/openapi.json').then(r=>r.json()).then(schema=>{
  for(const [path,methods] of Object.entries(schema.paths)) {
    for(const [method,operation] of Object.entries(methods)) {
      const section=document.createElement('details');section.className='panel methodology';
      const summary=document.createElement('summary');summary.textContent=`${method.toUpperCase()} ${path} · ${operation.summary||''}`;section.append(summary);
      const pre=document.createElement('pre');pre.className='schema-code';pre.textContent=JSON.stringify({parameters:operation.parameters,requestBody:operation.requestBody,responses:operation.responses},null,2);section.append(pre);
      document.getElementById('api-paths').append(section);
    }
  }
  for(const [name,definition] of Object.entries(schema.components?.schemas||{})) {
    const section=document.createElement('details');section.className='panel methodology';
    const summary=document.createElement('summary');summary.textContent=name;section.append(summary);
    const pre=document.createElement('pre');pre.className='schema-code';pre.textContent=JSON.stringify(definition,null,2);section.append(pre);
    document.getElementById('api-schemas').append(section);
  }
}).catch(()=>{document.getElementById('api-paths').textContent='Не удалось загрузить схему API.';});
