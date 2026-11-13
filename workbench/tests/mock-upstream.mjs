import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 18999);
const reply = process.argv[3] ?? 'HARNESS_MOCK_OK';
const log = process.argv[4] ?? 'workbench/.logs/mock-requests.log';

const server = createServer(async (request, response) => {
  if (request.url === '/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }, { id: 'deepseek-v4-pro', object: 'model' }] }));
    return;
  }
  if (request.url === '/responses' && request.method === 'POST') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(raw);
    const toText = item => typeof item?.content === 'string'
      ? item.content
      : (item?.content ?? []).map(part => part.text ?? '').join(' ');
    const users = (body.input ?? []).filter(item => item.role === 'user');
    const lastUser = users[users.length - 1];
    const text = toText(lastUser);
    const allText = users.map(toText).join('\n');
    appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), model: body.model, tools: body.tools?.length ?? 0, text: text.slice(0, 200) }) + '\n');
    const answer = allText.includes('Generate the session title')
      ? 'Mock Session Title'
      : process.env.HARNESS_MOCK_NO_ECHO === '1'
        ? `${reply}`
        : (allText.match(/HARNESS_MOCK_OK(?:_[A-Za-z0-9]+)?/)?.[0] ?? `${reply}`);
    const id = `resp_${Date.now()}`;
    const item = { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
    const events = [
      ['response.created', { type: 'response.created', response: { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: body.model, output: [] } }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: item.id, type: 'message', role: 'assistant', status: 'in_progress', content: [] } }],
      ['response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer }],
      ['response.output_text.done', { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: answer }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
      ['response.completed', { type: 'response.completed', response: { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: body.model, output: [item], usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 20 } } }],
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    for (const [type, data] of events) response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
    return;
  }
  response.writeHead(404).end('{}');
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`mock upstream http://127.0.0.1:${port}\n`));
