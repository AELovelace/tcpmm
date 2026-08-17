import './style.css'

type Genre = 'all' | 'punk' | 'metal' | 'hardcore' | 'other'

type ContentEvent = {
  id: number
  event_date: string
  title: string
  venue: string
  city: string
  lineup: string
  genre: Exclude<Genre, 'all'>
  price: string
  doors: string
  featured: number
}

type NewsItem = { id: number; label: string; title: string; summary: string; link: string; featured: number }
type SiteSettings = Record<string, string>

type ChatMessage = {
  id: number
  name: string
  text: string
  createdAt: number
  system?: boolean
}

let events: ContentEvent[] = [
  { id: 1, event_date: '2026-08-23', title: 'RIVER RAT RIOT', venue: 'The Hideaway', city: 'Kennewick', lineup: 'Motel Saints / Cheap Teeth / Bad Static', genre: 'punk', price: '$10', doors: '7 PM', featured: 1 },
  { id: 2, event_date: '2026-08-29', title: 'HEAVY WEATHER', venue: 'The Vault', city: 'Pasco', lineup: 'Grave Signal / Black Lung / Maw', genre: 'metal', price: '$15', doors: '6 PM', featured: 0 },
  { id: 3, event_date: '2026-09-05', title: 'NO BARRIERS', venue: 'DIY Space', city: 'Richland', lineup: 'Exit Wound / Cold Comfort / Loose Ends', genre: 'hardcore', price: '$8', doors: '7 PM', featured: 0 },
  { id: 4, event_date: '2026-09-13', title: 'FREAK FREQUENCIES', venue: 'Uptown Room', city: 'Richland', lineup: 'Ghost Bloom / Static TV / DJ Rat King', genre: 'other', price: '$12', doors: '8 PM', featured: 0 },
]

const escapeHtml = (value: unknown) => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character)

const defaultMessages: ChatMessage[] = [
  { id: 0, name: 'SYSTEM', text: 'Chat server is unavailable. Reconnecting…', createdAt: Date.now(), system: true },
]

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('Application mount point not found')

app.innerHTML = `
  <div class="site-shell">
    <header class="mobile-header">
      <a class="mini-mark" href="#top" aria-label="Tri-Cities Punk, Metal and More home">TC<span>//</span>PM&M</a>
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="left-rail">MENU + CHAT</button>
    </header>

    <aside class="left-rail" id="left-rail" aria-label="Site navigation and community chat">
      <div class="brand-block" id="top">
        <div class="eyebrow">EST. 2026 · 509 UNDERGROUND</div>
        <a class="brand" href="#shows" aria-label="Tri-Cities Punk, Metal and More home">
          <span>TRI-CITIES</span>
          <strong>PUNK,<br />METAL</strong>
          <em>& MORE</em>
        </a>
      </div>

      <nav class="primary-nav" aria-label="Main navigation">
        <a class="active" href="#shows"><span>01</span> SHOWS</a>
        <a href="#news"><span>02</span> SCENE NEWS</a>
        <a href="#venues"><span>03</span> VENUES</a>
        <a href="/submit/"><span>04</span> SUBMIT A SHOW</a>
      </nav>

      <div class="community-status">
        <span class="pulse" aria-hidden="true"></span>
        <div><strong>COMMUNITY LINE</strong><small id="chat-status">CONNECTING</small></div>
      </div>

      <section class="chat" aria-labelledby="chat-title">
        <div class="section-bar">
          <h2 id="chat-title">// CHATROOM</h2>
          <button class="text-button" id="refresh-chat" type="button">REFRESH</button>
        </div>
        <div class="chat-log" id="chat-log" aria-live="polite" aria-label="Chat messages"></div>
        <form class="chat-form" id="chat-form">
          <label class="sr-only" for="chat-name">Display name</label>
          <input id="chat-name" name="name" maxlength="18" placeholder="NAME" autocomplete="nickname" required />
          <label class="sr-only" for="chat-message">Message</label>
          <div class="message-row">
            <input id="chat-message" name="message" maxlength="120" placeholder="SAY SOMETHING..." autocomplete="off" required />
            <button type="submit" aria-label="Send message">↗</button>
          </div>
        </form>
        <p class="local-note" id="chat-note" role="status"></p>
      </section>
    </aside>

    <main class="main-pane" id="main-content">
      <section class="hero" aria-labelledby="hero-title">
        <div class="hero-kicker"><span>KENNEWICK</span><i></i><span>PASCO</span><i></i><span>RICHLAND</span></div>
        <h1 id="hero-title">MAKE<br /><span>YOUR OWN</span><br />NOISE.</h1>
        <p id="hero-text">Your independent wire for loud rooms, weird sounds, DIY culture, and everything happening after dark in Washington's Tri-Cities.</p>
        <a class="cta" href="#shows">FIND A SHOW <span>↓</span></a>
        <div class="hero-stamp" aria-hidden="true">ALL AGES<br />WHEN<br />POSSIBLE</div>
      </section>

      <section class="shows-section" id="shows" aria-labelledby="shows-title">
        <div class="heading-row">
          <div><span class="section-index">01 / CALENDAR</span><h2 id="shows-title">// UPCOMING SHOWS</h2></div>
          <p>NO ALGORITHMS.<br />JUST SHOWS.</p>
        </div>
        <div class="filters" role="group" aria-label="Filter shows by genre">
          <button class="filter active" type="button" data-genre="all">ALL</button>
          <button class="filter" type="button" data-genre="punk">PUNK</button>
          <button class="filter" type="button" data-genre="metal">METAL</button>
          <button class="filter" type="button" data-genre="hardcore">HARDCORE</button>
          <button class="filter" type="button" data-genre="other">OTHER</button>
        </div>
        <div class="event-list" id="event-list"></div>
      </section>

      <section class="news-section" id="news" aria-labelledby="news-title">
        <div class="heading-row inverted">
          <div><span class="section-index">02 / TRANSMISSIONS</span><h2 id="news-title">FROM THE SCENE</h2></div>
        </div>
        <div class="news-grid" id="news-grid">
          <article class="lead-story">
            <div class="story-art" aria-hidden="true"><span>509</span><b>LOUD</b></div>
            <span class="tag">SCENE REPORT</span>
            <h3>DIY IS NOT A GENRE.<br />IT'S HOW WE SURVIVE.</h3>
            <p>A starter guide to booking a room, making a bill, and keeping the door open for the next band.</p>
            <a href="/submit/">READ TRANSMISSION →</a>
          </article>
          <div class="news-stack">
            <article><span>CALL FOR SUBMISSIONS · AUG 16</span><h3>Send us your flyers, demos, photos, and dispatches.</h3><a href="/submit/" aria-label="Submit a show">↗</a></article>
            <article id="venues"><span>VENUE WATCH · AUG 11</span><h3>Four rooms keeping original music on the calendar.</h3><a href="#shows" aria-label="Read venue watch">↗</a></article>
            <article><span>NEW RELEASE · AUG 03</span><h3>Three local records for your next late-night drive.</h3><a href="#radio" aria-label="Read local record roundup">↗</a></article>
          </div>
        </div>
      </section>

      <section class="submit-strip" id="submit" aria-labelledby="submit-title">
        <div class="submit-heading"><span>GOT A SHOW?</span><h2 id="submit-title">PUT IT ON THE BOARD.</h2><p>Send the details to the crew for review.</p></div>
        <a href="/submit/">SUBMIT A SHOW ↗</a>
      </section>

      <footer><strong>TRI-CITIES PUNK, METAL & MORE</strong><span>BUILT FOR THE SCENE - DESIGNED AND HOSTED BY <a href="https://sadgirlsclub.wtf">SADGIRLSCLUB.WTF</a></span><a href="#top">BACK TO TOP ↑</a></footer>
    </main>

    <aside class="right-rail" aria-label="Radio and live show board">
      <section class="radio" id="radio" aria-labelledby="radio-title">
        <div class="section-bar radio-bar"><h2 id="radio-title">TCPM&M // RADIO</h2><span><i></i> <b id="radio-status">OFFLINE</b></span></div>
        <div class="radio-screen">
          <span class="frequency">509.0</span>
          <div class="wave" id="radio-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <p>LIVE AUDIO<br />BROADCAST</p>
        </div>
        <div class="now-playing"><span>NOW PLAYING</span><strong id="radio-track">NO SIGNAL</strong><small id="radio-message"></small></div>
        <div class="volume"><label for="radio-volume">VOL</label><input id="radio-volume" type="range" min="0" max="100" value="70" aria-label="Radio volume" /><span id="radio-volume-value">70</span><button id="radio-play" type="button" aria-label="Play radio">▶</button></div>
      </section>

      <section class="live-board" aria-labelledby="board-title">
        <div class="section-bar"><h2 id="board-title">// LIVE SHOW BOARD</h2><span class="live-dot">LIVE</span></div>
        <p class="board-date">THIS WEEK · TRI-CITIES, WA</p>
        <article class="board-feature" id="board-feature">
          <div class="board-date-block"><strong>23</strong><span>AUG<br />SAT</span></div>
          <span class="genre-label">PUNK / GARAGE</span>
          <h3>RIVER RAT<br />RIOT</h3>
          <p>MOTEL SAINTS<br />CHEAP TEETH<br />BAD STATIC</p>
          <div><span>THE HIDEAWAY</span><span>7 PM · $10</span></div>
        </article>
        <div class="board-list" id="board-list">
          <article><time>08.29</time><div><strong>HEAVY WEATHER</strong><span>THE VAULT · PASCO</span></div><b>→</b></article>
          <article><time>09.05</time><div><strong>NO BARRIERS</strong><span>DIY SPACE · RICHLAND</span></div><b>→</b></article>
          <article><time>09.13</time><div><strong>FREAK FREQUENCIES</strong><span>UPTOWN ROOM · RICHLAND</span></div><b>→</b></article>
        </div>
        <a class="board-link" href="#shows">FULL CALENDAR ↓</a>
      </section>

      <div class="right-footer"><span>WANT YOUR SHOW HERE?</span><a href="/submit/">SUBMIT A SHOW ↗</a></div>
    </aside>
  </div>
`

const eventList = document.querySelector<HTMLDivElement>('#event-list')
const renderEvents = (genre: Genre) => {
  if (!eventList) return
  const visible = events.filter((event) => genre === 'all' || event.genre === genre)
  eventList.innerHTML = visible.map((event) => {
    const date = new Date(`${event.event_date}T12:00:00`)
    const day = String(date.getDate()).padStart(2, '0')
    const month = date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()
    return `
    <article class="event-card" data-genre="${event.genre}">
      <time datetime="${event.event_date}"><strong>${day}</strong><span>${month}</span></time>
      <div class="event-info"><span class="tag">${event.genre}</span><h3>${escapeHtml(event.title)}</h3><p>${escapeHtml(event.lineup)}</p><small>${escapeHtml(event.venue)} · ${escapeHtml(event.city)}</small></div>
      <div class="event-meta"><strong>${escapeHtml(event.price)}</strong><span>DOORS ${escapeHtml(event.doors)}</span><a href="/submit/" aria-label="Submit a show like ${escapeHtml(event.title)}">SUBMIT ↗</a></div>
    </article>
  `}).join('')
}
renderEvents('all')

const renderNews = (items: NewsItem[]) => {
  const grid = document.querySelector<HTMLDivElement>('#news-grid')
  if (!grid || !items.length) return
  const lead = items.find((item) => item.featured) ?? items[0]
  const secondary = items.filter((item) => item.id !== lead.id).slice(0, 3)
  grid.innerHTML = `
    <article class="lead-story">
      <div class="story-art" aria-hidden="true"><span>509</span><b>LOUD</b></div>
      <span class="tag">${escapeHtml(lead.label)}</span>
      <h3>${escapeHtml(lead.title)}</h3><p>${escapeHtml(lead.summary)}</p>
      <a href="${escapeHtml(lead.link)}">READ TRANSMISSION →</a>
    </article>
    <div class="news-stack">${secondary.map((item) => `<article><span>${escapeHtml(item.label)}</span><h3>${escapeHtml(item.title)}</h3><a href="${escapeHtml(item.link)}" aria-label="Read ${escapeHtml(item.title)}">↗</a></article>`).join('')}</div>`
}

const renderBoard = () => {
  const featured = events.find((event) => event.featured) ?? events[0]
  const featureNode = document.querySelector<HTMLElement>('#board-feature')
  const listNode = document.querySelector<HTMLDivElement>('#board-list')
  if (!featured || !featureNode || !listNode) return
  const date = new Date(`${featured.event_date}T12:00:00`)
  featureNode.innerHTML = `<div class="board-date-block"><strong>${String(date.getDate()).padStart(2, '0')}</strong><span>${date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}<br />${date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()}</span></div><span class="genre-label">${escapeHtml(featured.genre)}</span><h3>${escapeHtml(featured.title)}</h3><p>${escapeHtml(featured.lineup).replaceAll(' / ', '<br />')}</p><div><span>${escapeHtml(featured.venue)} · ${escapeHtml(featured.city)}</span><span>${escapeHtml(featured.doors)} · ${escapeHtml(featured.price)}</span></div>`
  listNode.innerHTML = events.filter((event) => event.id !== featured.id).slice(0, 3).map((event) => { const itemDate = new Date(`${event.event_date}T12:00:00`); return `<article><time>${String(itemDate.getMonth() + 1).padStart(2, '0')}.${String(itemDate.getDate()).padStart(2, '0')}</time><div><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.venue)} · ${escapeHtml(event.city)}</span></div><b>→</b></article>` }).join('')
}

const applySettings = (settings: SiteSettings) => {
  const titleParts = (settings.hero_title || '').split('|')
  const title = document.querySelector<HTMLHeadingElement>('#hero-title')
  if (title && titleParts.length === 3) title.innerHTML = `${escapeHtml(titleParts[0])}<br /><span>${escapeHtml(titleParts[1])}</span><br />${escapeHtml(titleParts[2])}`
  const text = document.querySelector<HTMLElement>('#hero-text'); if (text && settings.hero_text) text.textContent = settings.hero_text
  const status = document.querySelector<HTMLElement>('#radio-status'); if (status) status.textContent = settings.radio_status || 'OFFLINE'
  const track = document.querySelector<HTMLElement>('#radio-track'); if (track) track.textContent = settings.radio_title || 'NO SIGNAL'
  const message = document.querySelector<HTMLElement>('#radio-message'); if (message) message.textContent = settings.radio_message || ''
}

const loadManagedContent = async () => {
  try {
    const response = await fetch('/api/content', { cache: 'no-store' })
    if (!response.ok) return
    const data = await response.json() as { events: ContentEvent[]; news: NewsItem[]; settings: SiteSettings }
    events = data.events
    renderEvents('all'); renderBoard(); renderNews(data.news); applySettings(data.settings)
  } catch { /* Static Vite development keeps the bundled fallback content. */ }
}
renderBoard()
void loadManagedContent()

const radioAudio = new Audio('/radio/stream')
radioAudio.preload = 'none'
radioAudio.volume = 0.7
const radioPlay = document.querySelector<HTMLButtonElement>('#radio-play')
const radioVolume = document.querySelector<HTMLInputElement>('#radio-volume')
const radioVolumeValue = document.querySelector<HTMLElement>('#radio-volume-value')
const radioWave = document.querySelector<HTMLElement>('#radio-wave')
let radioPlaying = false

const updateRadioStatus = async () => {
  try {
    const response = await fetch('/api/radio/status', { cache: 'no-store' })
    if (!response.ok) return
    const status = await response.json() as { online: boolean; title: string; trackCount: number }
    const statusNode = document.querySelector<HTMLElement>('#radio-status')
    const trackNode = document.querySelector<HTMLElement>('#radio-track')
    const messageNode = document.querySelector<HTMLElement>('#radio-message')
    if (statusNode) statusNode.textContent = status.online ? 'ON AIR' : 'OFFLINE'
    if (trackNode) trackNode.textContent = status.title
    if (messageNode) messageNode.textContent = status.trackCount ? `RANDOM LOOP · ${status.trackCount} TRACK${status.trackCount === 1 ? '' : 'S'}` : 'Add audio files to the music folder.'
    if (radioPlay) radioPlay.disabled = status.trackCount === 0
  } catch { /* The static development site has no radio API. */ }
}

radioPlay?.addEventListener('click', async () => {
  if (radioPlaying) {
    radioAudio.pause()
    radioAudio.src = ''
    radioPlaying = false
    radioPlay.textContent = '▶'
    radioPlay.setAttribute('aria-label', 'Play radio')
    return
  }
  radioAudio.src = `/radio/stream?t=${Date.now()}`
  try {
    await radioAudio.play()
    radioPlaying = true
    radioPlay.textContent = '■'
    radioPlay.setAttribute('aria-label', 'Stop radio')
  } catch {
    radioPlaying = false
    radioPlay.textContent = '▶'
  }
})
radioVolume?.addEventListener('input', () => {
  radioAudio.volume = Number(radioVolume.value) / 100
  if (radioVolumeValue) radioVolumeValue.textContent = radioVolume.value
})
radioAudio.addEventListener('error', () => {
  radioPlaying = false
  radioWave?.classList.remove('playing')
  if (radioPlay) {
    radioPlay.textContent = '▶'
    radioPlay.setAttribute('aria-label', 'Play radio')
  }
})
radioAudio.addEventListener('playing', () => radioWave?.classList.add('playing'))
radioAudio.addEventListener('pause', () => radioWave?.classList.remove('playing'))
radioAudio.addEventListener('waiting', () => radioWave?.classList.remove('playing'))
radioAudio.addEventListener('stalled', () => radioWave?.classList.remove('playing'))
radioAudio.addEventListener('ended', () => radioWave?.classList.remove('playing'))
void updateRadioStatus()
window.setInterval(() => void updateRadioStatus(), 5000)

document.querySelectorAll<HTMLButtonElement>('.filter').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((item) => item.classList.remove('active'))
    button.classList.add('active')
    renderEvents((button.dataset.genre ?? 'all') as Genre)
  })
})

const chatNameKey = 'tcpmm-chat-name'
const chatLog = document.querySelector<HTMLDivElement>('#chat-log')
const chatForm = document.querySelector<HTMLFormElement>('#chat-form')
const nameInput = document.querySelector<HTMLInputElement>('#chat-name')
const messageInput = document.querySelector<HTMLInputElement>('#chat-message')
const chatStatus = document.querySelector<HTMLElement>('#chat-status')
const chatNote = document.querySelector<HTMLElement>('#chat-note')
if (nameInput) nameInput.value = localStorage.getItem(chatNameKey) || ''

let messages: ChatMessage[] = defaultMessages
let chatLoading = false

const renderChat = () => {
  if (!chatLog) return
  chatLog.replaceChildren(...messages.map((message) => {
    const row = document.createElement('div')
    row.className = `chat-message${message.system ? ' system' : ''}`
    const meta = document.createElement('div')
    const name = document.createElement('strong')
    const time = document.createElement('time')
    const text = document.createElement('p')
    name.textContent = message.name
    time.dateTime = new Date(message.createdAt).toISOString()
    time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    text.textContent = message.text
    meta.append(name, time)
    row.append(meta, text)
    return row
  }))
  chatLog.scrollTop = chatLog.scrollHeight
}
renderChat()

const mergeMessages = (incoming: ChatMessage[], replace = false) => {
  const combined = replace ? incoming : [...messages.filter((message) => message.id > 0), ...incoming]
  messages = [...new Map(combined.map((message) => [message.id, message])).values()].sort((a, b) => a.id - b.id).slice(-100)
  renderChat()
}

const loadChat = async (replace = false) => {
  if (chatLoading || document.hidden) return
  chatLoading = true
  try {
    const lastId = replace ? 0 : Math.max(0, ...messages.map((message) => message.id))
    const response = await fetch(`/api/chat/messages${lastId ? `?after=${lastId}` : ''}`, { cache: 'no-store' })
    if (!response.ok) throw new Error('Chat request failed')
    const data = await response.json() as { messages: ChatMessage[] }
    mergeMessages(data.messages, replace || lastId === 0)
    if (chatStatus) chatStatus.textContent = 'LIVE · SERVER BACKED'
    if (chatNote) chatNote.textContent = ''
  } catch {
    if (chatStatus) chatStatus.textContent = 'RECONNECTING'
    if (chatNote) chatNote.textContent = 'CHAT UNAVAILABLE · RETRYING'
  } finally {
    chatLoading = false
  }
}

void loadChat(true)
window.setInterval(() => void loadChat(), 15_000)

if ('EventSource' in window) {
  const chatEvents = new EventSource('/api/chat/events')
  chatEvents.addEventListener('open', () => { if (chatStatus) chatStatus.textContent = 'LIVE · SERVER BACKED' })
  chatEvents.addEventListener('message', (event) => {
    try { mergeMessages([JSON.parse(event.data) as ChatMessage]) } catch { /* Polling will reconcile malformed or missed events. */ }
  })
  chatEvents.addEventListener('error', () => { if (chatStatus) chatStatus.textContent = 'RECONNECTING' })
}

chatForm?.addEventListener('submit', async (event) => {
  event.preventDefault()
  const name = nameInput?.value.trim()
  const text = messageInput?.value.trim()
  if (!name || !text) return
  const submit = chatForm.querySelector<HTMLButtonElement>('button[type="submit"]')
  if (submit) submit.disabled = true
  try {
    const response = await fetch('/api/chat/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, text })
    })
    const data = await response.json() as { message?: ChatMessage; error?: string }
    if (!response.ok || !data.message) throw new Error(data.error || 'Message could not be sent')
    localStorage.setItem(chatNameKey, name)
    mergeMessages([data.message])
    if (messageInput) { messageInput.value = ''; messageInput.focus() }
    if (chatNote) chatNote.textContent = ''
  } catch (error) {
    if (chatNote) chatNote.textContent = error instanceof Error ? error.message : 'Message could not be sent'
  } finally {
    if (submit) submit.disabled = false
  }
})

document.querySelector('#refresh-chat')?.addEventListener('click', () => void loadChat(true))

const menuToggle = document.querySelector<HTMLButtonElement>('.menu-toggle')
menuToggle?.addEventListener('click', () => {
  const open = document.body.classList.toggle('menu-open')
  menuToggle.setAttribute('aria-expanded', String(open))
})

document.querySelectorAll<HTMLAnchorElement>('.left-rail a').forEach((link) => {
  link.addEventListener('click', () => {
    document.body.classList.remove('menu-open')
    menuToggle?.setAttribute('aria-expanded', 'false')
  })
})
