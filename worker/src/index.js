// The class board's store, for one class game at a time per room.
//   POST /cuts            a player's cut (name + decomposition + scores). One per phone per round (409 on repeat);
//                         refused (423) while the game is closed.
//   GET  /cuts?room=…     the current round's cuts, one entry per phone (each carries its device id, so two
//                         students with the same name stay two entries).
//   GET  /state?room=…    { round, status: 'waiting' | 'open' | 'closed', endsAt (ms or null), now }
//   POST /admin           { room, key, action: 'start' (with minutes) | 'stop' | 'extend' (with seconds) | 'reset' }; key = the ADMIN_KEY secret.
//                         reset deletes the round's cuts and starts a new round (phones may play again).
// A room with no state yet is 'open' with no timer, so the game works without the control panel.
// Each room lives in its own Durable Object (strongly consistent: stop and reset take effect immediately).
// A room deletes itself seven days after its last write.
const MAX_BYTES = 16000
const TTL = 7 * 24 * 3600

function cors() {
	// any origin: the board and the game page live on GitHub Pages, the control panel inside the tldraw app;
	// admin actions are protected by the key, not by the origin
	return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' }
}
const json = (req, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) } })
const word = (s, n) => typeof s === 'string' && s.length > 0 && s.length <= n
const roomOk = (r) => typeof r === 'string' && /^[a-z0-9-]{1,40}$/.test(r)

function clean(b) {
	if (!roomOk(b.room)) throw new Error('bad room')
	if (!word(b.group, 30)) throw new Error('give a name of up to 30 characters')
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

export class Room {
	constructor(ctx, env) { this.ctx = ctx; this.env = env; this.st = ctx.storage }
	async state() {
		const s = (await this.st.get('state')) ?? { round: 1, status: 'open', endsAt: null }
		if (s.status === 'open' && s.endsAt && Date.now() >= s.endsAt) s.status = 'closed' // the timer ran out
		return s
	}
	async touch() { await this.st.setAlarm(Date.now() + TTL * 1000) }
	async alarm() { await this.st.deleteAll() } // seven days without writes: forget the room
	async fetch(req) {
		const url = new URL(req.url)
		const room = url.searchParams.get('room')
		if (url.pathname === '/state') return json(req, { ...(await this.state()), now: Date.now() })
		if (url.pathname === '/admin') {
			const b = JSON.parse(await req.text())
			if (!this.env.ADMIN_KEY || b.key !== this.env.ADMIN_KEY) return json(req, { error: 'not allowed' }, 403)
			const s = await this.state()
			if (b.action === 'start') Object.assign(s, { status: 'open', endsAt: Date.now() + Math.min(60, Math.max(1, Number(b.minutes) || 5)) * 60000 })
			else if (b.action === 'stop') Object.assign(s, { status: 'closed', endsAt: null })
			else if (b.action === 'extend') {
				// add time (the presenter's hidden +1 min / +10 s); a timer that has just run out reopens
				const add = Math.min(600, Math.max(1, Number(b.seconds) || 60)) * 1000
				if (s.endsAt) Object.assign(s, { status: 'open', endsAt: Math.max(s.endsAt, Date.now()) + add })
			}
			else if (b.action === 'reset') {
				const keys = [...(await this.st.list({ prefix: 'cut:' })).keys(), ...(await this.st.list({ prefix: 'dev:' })).keys()]
				for (let i = 0; i < keys.length; i += 128) await this.st.delete(keys.slice(i, i + 128))
				Object.assign(s, { round: (s.round ?? 1) + 1, status: 'waiting', endsAt: null })
			} else return json(req, { error: 'bad action' }, 400)
			await this.st.put('state', s); await this.touch()
			return json(req, { ...s, now: Date.now() })
		}
		if (req.method === 'POST') {
			let rec, device
			try {
				const body = JSON.parse(await req.text()); rec = clean(body); rec.room = room
				device = body.device
				if (typeof device !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(device)) throw new Error('missing device id')
			} catch (e) { return json(req, { error: e.message }, 400) }
			const s = await this.state()
			if (s.status !== 'open') return json(req, { error: s.status === 'waiting' ? 'the game has not started yet' : 'time is up: the game is closed' }, 423)
			if (await this.st.get('dev:' + device)) return json(req, { error: 'already submitted' }, 409)
			rec.device = device; rec.round = s.round
			await this.st.put({ ['dev:' + device]: 1, [`cut:${rec.at}:${crypto.randomUUID().slice(0, 8)}`]: rec })
			await this.touch()
			return json(req, { ok: true, round: s.round })
		}
		return json(req, [...(await this.st.list({ prefix: 'cut:', limit: 500 })).values()])
	}
}

export default {
	async fetch(req, env) {
		const url = new URL(req.url)
		if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) })
		const known = { '/state': ['GET'], '/admin': ['POST'], '/cuts': ['GET', 'POST'] }
		if (!known[url.pathname]) return json(req, { error: 'not found' }, 404)
		if (!known[url.pathname].includes(req.method)) return json(req, { error: 'method not allowed' }, 405)
		const text = req.method === 'POST' ? await req.text() : ''
		if (text.length > MAX_BYTES) return json(req, { error: 'too large' }, 413)
		let room = url.searchParams.get('room')
		if (req.method === 'POST') { try { room = JSON.parse(text).room } catch { return json(req, { error: 'bad json' }, 400) } }
		if (!roomOk(room)) return json(req, { error: 'bad room' }, 400)
		const stub = env.ROOM.get(env.ROOM.idFromName(room))
		const inner = new Request(`https://room${url.pathname}?room=${room}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? text : undefined })
		return stub.fetch(inner)
	},
}
