import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const PROXY_TOKEN = (process.env.NETTUTOR_PROXY_TOKEN || '').trim();
const MODEL = (process.env.OPENAI_MODEL || 'gpt-5-mini').trim();
const ALLOWED_ORIGINS = (process.env.APP_ORIGINS || '*')
  .split(',').map(value => value.trim()).filter(Boolean);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 5000;
const MAX_REPLY_TOKENS = 900;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 12;
const requestsByIp = new Map();

const NETTUTOR_INSTRUCTIONS = `You are NetTutor, an AI networking tutor built specifically for students learning Cisco networking, Cisco Packet Tracer, and basic computer networking.

PRIMARY GOAL
Help students understand networking concepts, configure networks correctly, troubleshoot methodically, and learn Cisco IOS commands step by step. Stay focused on networking and Cisco/Packet Tracer education. If asked something unrelated, briefly redirect to networking.

CORE SUBJECTS
OSI and TCP/IP models; IPv4 and IPv6; IP addressing; subnetting; CIDR; subnet and wildcard masks; network address, broadcast address, usable host range and host counts; VLSM and FLSM; VLANs, access and voice VLANs, trunking, inter-VLAN routing and router-on-a-stick; DHCP; DNS; NAT and PAT; static and default routes; RIP, OSPF and EIGRP; STP; EtherChannel; port security; MAC addresses; ARP; ICMP; TCP and UDP; Ethernet; switches; routers; wireless networking; VoIP; Cisco Packet Tracer; Cisco IOS CLI; basic network security; and network troubleshooting.

TEACHING STYLE
Always explain in simple language and assume the student may be a beginner. When using a technical term, name it, explain it simply, and give a practical example. Build from simple ideas toward advanced ones. Use short sections and ordered steps when that makes an answer easier to follow. Ask for missing topology, addressing, VLAN, interface, device-model, or IOS-version details rather than guessing.

CISCO IOS COMMAND RULES
Use real Cisco IOS syntax only. Put Cisco commands in fenced text code blocks. State the CLI mode and prompt for each sequence (User EXEC >, Privileged EXEC #, Global Configuration (config)#, Interface Configuration (config-if)#, and other modes when relevant). Show commands in the correct order and explain what each command does. Do not invent commands, confuse IOS with Linux/Windows/Juniper syntax, or say that you executed IOS. Platform and Packet Tracer support can vary; say so when relevant. Prefer verified, commonly supported IOS syntax and ask for the device/model if uncertain.

NETWORKING ACCURACY
Never guess subnet-calculation results. If the user message includes a verified calculator context, use those values exactly and do not contradict them. If no verified result is supplied, show the method and ask for an address/prefix when an exact calculation is needed. Accept valid IPv4 prefixes /0 through /32. Distinguish subnet masks from wildcard masks, network from gateway, and ordinary host ranges from /31 point-to-point and /32 host-route behavior. Do not assume .1 is the gateway. Distinguish syntax errors from possible configuration/design problems. Treat a ping timeout as evidence, not a diagnosis.

PRIVACY AND SAFETY
Do not ask for API keys, passwords, or other secrets. Remind students not to paste production credentials or sensitive configurations. Your answer is educational; never claim to control a router, execute a command, or run Packet Tracer.`;

function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true; // Native Android bridge requests do not send a browser Origin.
  const allowed = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
  if (!allowed) return false;
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes('*') ? '*' : origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function authorized(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match || !PROXY_TOKEN) return false;
  const received = Buffer.from(match[1]);
  const expected = Buffer.from(PROXY_TOKEN);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function rateAllowed(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  const ip = forwarded.length ? forwarded[forwarded.length - 1] : String(req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  let record = requestsByIp.get(ip);
  if (!record || now - record.start >= RATE_WINDOW_MS) {
    record = { start: now, count: 0 };
    requestsByIp.set(ip, record);
  }
  record.count += 1;
  if (requestsByIp.size > 5000) {
    for (const [key, value] of requestsByIp) if (now - value.start >= RATE_WINDOW_MS) requestsByIp.delete(key);
    while (requestsByIp.size > 5000) requestsByIp.delete(requestsByIp.keys().next().value);
  }
  return record.count <= RATE_LIMIT;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Send valid JSON.'), { status: 400 }); }
}

function validateMessages(value) {
  if (!Array.isArray(value) || value.length < 1) throw Object.assign(new Error('Add a networking question first.'), { status: 400 });
  const messages = value.slice(-MAX_MESSAGES).map(item => {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') {
      throw Object.assign(new Error('Chat history has an unsupported message.'), { status: 400 });
    }
    const content = item.content.trim();
    if (!content || content.length > MAX_MESSAGE_CHARS) throw Object.assign(new Error('Each message must be 1–5000 characters.'), { status: 400 });
    return { role: item.role, content };
  });
  if (messages.at(-1).role !== 'user') throw Object.assign(new Error('The newest message must be a student question.'), { status: 400 });
  return messages;
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const chunks = [];
  for (const item of data?.output || []) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) if (part?.type === 'output_text' && part.text) chunks.push(part.text);
  }
  return chunks.join('\n').trim();
}

const server = http.createServer(async (req, res) => {
  if (!cors(req, res)) return json(res, 403, { error: 'This website origin is not allowed. Add its exact origin to APP_ORIGINS on your server.' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const path = new URL(req.url || '/', 'http://localhost').pathname;

  if (req.method === 'GET' && path === '/api/health') {
    if (!authorized(req)) return json(res, 401, { error: 'Proxy access code is missing or incorrect.' });
    const ready = !!OPENAI_API_KEY && !!PROXY_TOKEN;
    return json(res, ready ? 200 : 503, { ok: ready, model: MODEL, provider: 'OpenAI Responses API' });
  }

  if (req.method !== 'POST' || path !== '/api/chat') {
    return json(res, 404, { error: 'Route not found.' });
  }
  if (!authorized(req)) return json(res, 401, { error: 'Proxy access code is missing or incorrect.' });
  if (!rateAllowed(req)) return json(res, 429, { error: 'Too many requests from this network. Wait a minute and try again.' });
  if (!OPENAI_API_KEY) return json(res, 503, { error: 'The server owner has not added OPENAI_API_KEY in the hosting dashboard.' });

  try {
    const body = await readJson(req);
    const messages = validateMessages(body?.messages);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    let upstream;
    try {
      upstream = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          instructions: NETTUTOR_INSTRUCTIONS,
          input: messages,
          max_output_tokens: MAX_REPLY_TOKENS,
          store: false,
        }),
        signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }

    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.warn(`OpenAI Responses API returned HTTP ${upstream.status}.`);
      const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status === 429 ? 429 : 502;
      const publicMessage = upstream.status === 429
        ? 'OpenAI rate limit or account quota reached. Check API usage and billing in your OpenAI Platform account.'
        : 'OpenAI did not accept the request. The server owner should check the API key, model access, and server logs.';
      return json(res, status, { error: publicMessage });
    }
    const reply = extractOutputText(result);
    if (!reply) return json(res, 502, { error: 'OpenAI returned no text. Please try again.' });
    return json(res, 200, { reply, model: MODEL });
  } catch (error) {
    if (error?.name === 'AbortError') return json(res, 504, { error: 'The tutor took too long to answer. Try again.' });
    return json(res, error.status || 500, { error: error.status ? error.message : 'The tutor server encountered an error. Try again later.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NetTutor proxy listening on port ${PORT}.`);
  if (!OPENAI_API_KEY) console.warn('OPENAI_API_KEY is missing; add it as a private host environment variable.');
  if (!PROXY_TOKEN) console.warn('NETTUTOR_PROXY_TOKEN is missing; set a long random token before exposing this service.');
  if (ALLOWED_ORIGINS.includes('*')) console.warn('APP_ORIGINS is *, which allows browser requests from any origin; bearer-token authentication and rate limiting are still required.');
});
