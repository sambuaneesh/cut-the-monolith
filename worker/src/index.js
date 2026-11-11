// The class board's store. POST /cuts saves one submission (a player's name and their decomposition) for a class room;
// GET /cuts?room=… returns that room's submissions. One submission per device per room: the page sends a random
// device id (kept in the browser), and a second POST with the same id gets 409. Everything expires after seven days.
const ORIGINS = ['https://sambuaneesh.github.io', 'http://localhost:8000', 'http://127.0.0.1:8000']
const MAX_BYTES = 16000

function cors(req) {
	const o = req.headers.get('origin')
	return { 'access-control-allow-origin': ORIGINS.includes(o) ? o : ORIGINS[0], 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' }
}
const json = (req, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) } })
const word = (s, n) => typeof s === 'string' && s.length > 0 && s.length <= n

function clean(b) {
	if (!word(b.room, 40) || !/^[a-z0-9-]+$/.test(b.room)) throw new Error('bad room')
	if (!word(b.group, 30)) throw new Error('give a group name of up to 30 characters')
	if (!['hand', 'llm', 'trap'].includes(b.kind)) throw new Error('bad kind')
	const services = {}
	const entries = Object.entries(b.services ?? {})
	if (entries.length > 30) throw new Error('too many services')
	for (const [name, classes] of entries) {
		if (!word(name, 60) || !Array.isArray(classes) || classes.length > 60 || !classes.every((c) => word(c, 60))) throw new Error('bad service')
		services[name] = classes
	}
	const scores = {}
	for (const k of ['n', 'cmod', 'cid', 'dtp', 'di', 'bcp', 'c2c']) scores[k] = Number.isFinite(b.scores?.[k]) ? Math.round(b.scores[k] * 10) / 10 : null
	scores.valid = b.scores?.valid === true
	return { group: b.group, kind: b.kind, services, unassigned: Number.isInteger(b.unassigned) ? b.unassigned : 0, scores, at: Date.now() }
}

export default {
	async fetch(req, env) {
		const url = new URL(req.url)
		if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) })
		if (url.pathname !== '/cuts') return json(req, { error: 'not found' }, 404)
		if (req.method === 'POST') {
			const text = await req.text()
			if (text.length > MAX_BYTES) return json(req, { error: 'too large' }, 413)
			let rec, device
			try {
				const body = JSON.parse(text); rec = clean(body); rec.room = body.room
				device = body.device
				if (typeof device !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(device)) throw new Error('missing device id')
			} catch (e) { return json(req, { error: e.message }, 400) }
			const seen = `dev:${rec.room}:${device}`
			if (await env.CUTS.get(seen)) return json(req, { error: 'already submitted' }, 409)
			await env.CUTS.put(seen, '1', { expirationTtl: 7 * 24 * 3600 })
			const key = `${rec.room}:${rec.at}:${crypto.randomUUID().slice(0, 8)}`
			await env.CUTS.put(key, JSON.stringify(rec), { expirationTtl: 7 * 24 * 3600 })
			return json(req, { ok: true })
		}
		if (req.method === 'GET') {
			const room = url.searchParams.get('room') ?? ''
			if (!/^[a-z0-9-]{1,40}$/.test(room)) return json(req, { error: 'bad room' }, 400)
			const list = await env.CUTS.list({ prefix: room + ':', limit: 500 })
			const rows = await Promise.all(list.keys.map(async (k) => JSON.parse((await env.CUTS.get(k.name)) ?? 'null')))
			return json(req, rows.filter(Boolean))
		}
		return json(req, { error: 'method not allowed' }, 405)
	},
}
