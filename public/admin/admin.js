let csrfToken = ''
let currentAdminId = null
let currentUsername = ''
let currentRole = ''
let content = { events: [], news: [], venues: [], submissions: [], admins: [], showApiKeys: [], settings: {} }
let submissionFilter = 'all'
let submissionsLoading = false
const $ = (selector) => document.querySelector(selector)
const status = (message, error = false) => { const node = $('#status'); node.textContent = message; node.style.color = error ? '#ff7187' : '#ff2948' }
const api = async (url, options = {}) => {
  const response = await fetch(url, { cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...options.headers } })
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || `Request failed: ${response.status}`) }
  return response.status === 204 ? null : response.json()
}
const formObject = (form) => Object.fromEntries(new FormData(form).entries())
const applyRoleAccess = () => {
  const administrator = currentRole === 'admin'
  document.querySelectorAll('nav [data-admin-only]').forEach((node) => { node.hidden = !administrator })
  if (!administrator && (!$('#users-view').hidden || !$('#api-keys-view').hidden)) document.querySelector('nav button[data-view="settings"]').click()
  if (!administrator) document.querySelectorAll('.view[data-admin-only]').forEach((node) => { node.hidden = true })
} // Removes privileged navigation and views for organizers while the server remains the final enforcement boundary.
const setAuthenticated = async (session) => {
  csrfToken = session.csrfToken
  currentAdminId = session.id
  currentUsername = session.username
  currentRole = session.role
  $('#operator').textContent = `OPERATOR: ${currentUsername} · ${currentRole.toUpperCase()}`
  $('#logout').hidden = false; $('#login-view').hidden = true; $('#control-view').hidden = false
  applyRoleAccess()
  await loadContent()
}
const loadContent = async () => {
  content = await api('/api/admin/content')
  currentUsername = content.username
  currentRole = content.role
  $('#operator').textContent = `OPERATOR: ${currentUsername} · ${currentRole.toUpperCase()}`
  applyRoleAccess()
  fillSettings(); renderSubmissions(); renderEvents(); renderVenues(); renderNews()
  if (currentRole === 'admin') { renderUsers(); renderApiKeys() }
} // Loads common organizational data for both tiers and renders sensitive data only for full administrators.
const fillSettings = () => Object.entries(content.settings).forEach(([key, value]) => { const field = $(`#settings-form [name="${key}"]`); if (field) field.value = value })
const renderEvents = () => { $('#event-list').innerHTML = content.events.map((item) => `<article class="record"><div><strong>${escapeHtml(item.title)}</strong><span>${item.event_date} // ${escapeHtml(item.venue)}, ${escapeHtml(item.city)} ${item.published ? '' : '<b class="draft">[DRAFT]</b>'}</span></div><div><button data-edit-event="${item.id}">EDIT</button><button class="danger" data-delete-event="${item.id}">DELETE</button></div></article>`).join('') }
const renderNews = () => { $('#news-list').innerHTML = content.news.map((item) => `<article class="record"><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.label)} · ${item.body_html ? 'STATIC ARTICLE' : 'LINK ONLY'} ${item.published ? '' : '<b class="draft">[DRAFT]</b>'}</span></div><div>${item.body_html && item.published ? `<a class="button-link" href="${escapeHtml(item.link)}" target="_blank">VIEW ↗</a>` : ''}<button data-edit-news="${item.id}">EDIT</button><button class="danger" data-delete-news="${item.id}">DELETE</button></div></article>`).join('') }
const renderVenues = () => { $('#venue-list').innerHTML = content.venues.length ? content.venues.map((item) => `<article class="record venue-record">${item.image_path ? `<img src="${escapeHtml(item.image_path)}" alt="" />` : '<span class="venue-record-placeholder">NO IMG</span>'}<div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.address)} · ${escapeHtml(item.city)} ${item.published ? '' : '<b class="draft">[DRAFT]</b>'}</span></div><div><button data-edit-venue="${item.id}">EDIT</button><button class="danger" data-delete-venue="${item.id}">DELETE</button></div></article>`).join('') : '<p class="empty">NO VENUES IN THE DIRECTORY.</p>' }
const renderSubmissions = () => {
  const unread = content.submissions.filter((item) => !item.reviewed).length
  const reviewed = content.submissions.length - unread
  $('#submission-count').textContent = unread ? `[${unread}]` : ''
  $('#submission-new-count').textContent = unread
  $('#submission-reviewed-count').textContent = reviewed
  $('#submission-total-count').textContent = content.submissions.length
  document.title = unread ? `(${unread}) TCPM&M // CONTROL` : 'TCPM&M // CONTROL'
  const visible = content.submissions.filter((item) => submissionFilter === 'all' || (submissionFilter === 'reviewed') === Boolean(item.reviewed))
  $('#submission-list').innerHTML = visible.length ? visible.map((item) => `<article class="submission-record${item.reviewed ? ' reviewed' : ''}">
    <div class="submission-head"><div><strong>${escapeHtml(item.title || item.venue)}</strong><span>${escapeHtml(item.event_date)} · ${escapeHtml(item.venue)}, ${escapeHtml(item.city || 'CITY NEEDED')} · RECEIVED ${escapeHtml(item.created_at)}</span></div>${item.published_event_id ? '<b class="current">[PUBLISHED]</b>' : item.reviewed ? '<b class="draft">[REVIEWED]</b>' : '<b class="current">[NEW]</b>'}</div>
    <dl><dt>GENRE</dt><dd>${escapeHtml(item.genre || 'other')}</dd><dt>PRICE / DOORS</dt><dd>${escapeHtml(item.price || '—')} / ${escapeHtml(item.doors || '—')}</dd><dt>CONTACT</dt><dd>${escapeHtml(item.contact || 'Not provided')}</dd><dt>ADDRESS</dt><dd>${escapeHtml(item.address)}</dd><dt>LINEUP</dt><dd>${escapeHtml(item.lineup)}</dd><dt>DESCRIPTION</dt><dd>${escapeHtml(item.description)}</dd></dl>
    <div class="actions">${item.published_event_id ? `<button data-edit-event-from-submission="${item.published_event_id}">EDIT PUBLISHED EVENT</button>` : `<button data-publish-submission="${item.id}"${!item.title || !item.city ? ' disabled title="Add the missing title and city first"' : ''}>PUBLISH EVENT</button>`}<button data-edit-submission="${item.id}">EDIT</button><button data-review-submission="${item.id}" data-reviewed="${item.reviewed ? 'true' : 'false'}">${item.reviewed ? 'MARK NEW' : 'MARK REVIEWED'}</button><button class="danger" data-delete-submission="${item.id}">DELETE</button></div>
  </article>`).join('') : `<p class="empty">NO ${submissionFilter === 'all' ? '' : `${submissionFilter.toUpperCase()} `}SHOW SUBMISSIONS.</p>`
}
const loadSubmissions = async (announce = false) => {
  if (submissionsLoading || !csrfToken) return
  submissionsLoading = true
  try {
    const data = await api('/api/admin/submissions')
    content.submissions = data.submissions
    renderSubmissions()
    const updated = $('#submission-updated')
    updated.textContent = `LAST CHECKED ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    if (announce) status('SUBMISSIONS REFRESHED')
  } catch (error) { if (announce) status(error.message, true) }
  finally { submissionsLoading = false }
}
const renderUsers = () => { $('#user-list').innerHTML = content.admins.map((item) => `<article class="record"><div><strong>${escapeHtml(item.username)} ${item.id === currentAdminId ? '<b class="current">[CURRENT]</b>' : ''}</strong><span>${escapeHtml(item.role.toUpperCase())} · CREATED ${escapeHtml(item.created_at)}</span></div><div><button data-edit-user="${item.id}">EDIT</button><button class="danger" data-delete-user="${item.id}"${item.id === currentAdminId ? ' disabled title="You cannot delete your own account"' : ''}>DELETE</button></div></article>`).join('') }
const renderApiKeys = () => {
  $('#api-key-list').innerHTML = content.showApiKeys.length ? content.showApiKeys.map((item) => {
    if (item.source === 'environment') return `<article class="record"><div><strong>${escapeHtml(item.name)} <b class="api-key-source">[ENV]</b></strong><span class="api-key-meta">SERVER-CONFIGURED · REMOVE FROM SHOW_API_KEYS AND RESTART TO REVOKE</span></div></article>`
    const usage = item.last_used_at ? `LAST USED ${escapeHtml(item.last_used_at)} · ${item.request_count} REQUEST${item.request_count === 1 ? '' : 'S'}` : 'NEVER USED'
    return `<article class="record"><div><strong>${escapeHtml(item.name)}</strong><span class="api-key-meta">CREATED ${escapeHtml(item.created_at)} BY ${escapeHtml(item.created_by || 'DELETED ADMIN')} · ${usage}</span></div><div><button class="danger" data-revoke-api-key="${escapeHtml(item.id)}">REVOKE</button></div></article>`
  }).join('') : '<p class="empty">NO SHOW API KEYS. GENERATE ONE FOR EACH TRUSTED PUBLISHER.</p>'
} // Renders database keys with usage data and distinguishes legacy environment credentials that need server access to revoke.
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char])
const openEditor = (type, item = null) => {
  const form = $(`#${type}-form`); form.reset(); form.hidden = false
  if (item) Object.entries(item).forEach(([key, value]) => { const field = form.elements.namedItem(key); if (!field) return; if (field.type === 'checkbox') field.checked = Boolean(value); else field.value = value })
  else { form.elements.namedItem('published').checked = true; form.elements.namedItem('id').value = '' }
  if (type === 'news') {
    $('#article-editor').innerHTML = item?.body_html || ''
    $('#article-editor').classList.remove('preview-mode')
    $('.wysiwyg-toolbar').hidden = false
    $('#preview-news').textContent = 'PREVIEW'
    form.elements.namedItem('slug').dataset.manual = item ? 'true' : 'false'
  }
  if (type === 'venue') {
    const preview = $('#venue-image-preview')
    preview.src = item?.image_path || ''
    preview.hidden = !item?.image_path
    $('#venue-image-empty').hidden = Boolean(item?.image_path)
    $('#remove-venue-image').hidden = !item?.image_path
  }
  form.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
const openUserEditor = (item = null) => {
  const form = $('#user-form'); form.reset(); form.hidden = false
  form.elements.namedItem('id').value = item?.id || ''
  form.elements.namedItem('username').value = item?.username || ''
  form.elements.namedItem('role').value = item?.role || 'organizer'
  form.elements.namedItem('password').required = !item
  $('#password-help').textContent = item ? 'Leave blank to keep current password' : '12–128 characters'
  form.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
const openSubmissionEditor = (item) => {
  const form = $('#submission-editor'); form.reset(); form.hidden = false
  Object.entries(item).forEach(([key, value]) => { const field = form.elements.namedItem(key); if (!field) return; if (field.type === 'checkbox') field.checked = Boolean(value); else field.value = value })
  form.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const data = formObject(event.currentTarget); await setAuthenticated(await api('/api/admin/login', { method:'POST', body:JSON.stringify(data) })) } catch (error) { alert(error.message) } })
$('#logout').addEventListener('click', async () => { await api('/api/admin/logout', { method:'POST' }); location.reload() })
document.querySelectorAll('nav button').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('nav button').forEach((item) => item.classList.toggle('active', item === button)); document.querySelectorAll('.view').forEach((view) => { view.hidden = view.id !== `${button.dataset.view}-view` }) }))
$('#settings-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/admin/settings', { method:'PUT', body:JSON.stringify(formObject(event.currentTarget)) }); status('SETTINGS SAVED'); await loadContent() } catch (error) { status(error.message, true) } })
$('#new-event').addEventListener('click', () => openEditor('event'))
$('#new-venue').addEventListener('click', () => openEditor('venue'))
$('#new-news').addEventListener('click', () => openEditor('news'))
$('#new-user').addEventListener('click', () => openUserEditor())
$('#new-api-key').addEventListener('click', () => { const form = $('#api-key-form'); form.reset(); form.hidden = false; form.elements.namedItem('name').focus() })
const newsTitle = $('#news-form [name="title"]')
const newsSlug = $('#news-form [name="slug"]')
const articleEditor = $('#article-editor')
const slugify = (value) => String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
newsTitle.addEventListener('input', () => { if (newsSlug.dataset.manual !== 'true') newsSlug.value = slugify(newsTitle.value) })
newsSlug.addEventListener('input', () => { newsSlug.dataset.manual = 'true'; newsSlug.value = slugify(newsSlug.value) })
let editorRange = null
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection()
  if (selection?.rangeCount && articleEditor.contains(selection.anchorNode)) editorRange = selection.getRangeAt(0).cloneRange()
})
const restoreEditorSelection = () => {
  articleEditor.focus()
  if (!editorRange) return
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(editorRange)
}
document.querySelectorAll('[data-editor-command]').forEach((button) => button.addEventListener('mousedown', (event) => event.preventDefault()))
document.querySelectorAll('[data-editor-command]').forEach((button) => button.addEventListener('click', () => {
  restoreEditorSelection()
  document.execCommand(button.dataset.editorCommand, false, button.dataset.editorValue || null)
}))
$('[data-editor-link]').addEventListener('mousedown', (event) => event.preventDefault())
$('[data-editor-link]').addEventListener('click', () => {
  const href = prompt('Link URL (https://, /local-path, #section, or mailto:)', 'https://')
  if (!href || !/^(https?:\/\/|mailto:|\/|#)/i.test(href)) return
  restoreEditorSelection()
  document.execCommand('createLink', false, href)
})
$('#preview-news').addEventListener('click', () => {
  const previewing = articleEditor.classList.toggle('preview-mode')
  $('.wysiwyg-toolbar').hidden = previewing
  $('#preview-news').textContent = previewing ? 'CONTINUE EDITING' : 'PREVIEW'
})
$('#refresh-submissions').addEventListener('click', () => loadSubmissions(true))
document.querySelectorAll('[data-submission-filter]').forEach((button) => button.addEventListener('click', () => {
  submissionFilter = button.dataset.submissionFilter
  document.querySelectorAll('[data-submission-filter]').forEach((item) => item.classList.toggle('active', item === button))
  renderSubmissions()
}))
document.querySelectorAll('.cancel').forEach((button) => button.addEventListener('click', () => { button.closest('form').hidden = true }))
const saveRecord = async (event, type) => { event.preventDefault(); const form = event.currentTarget; if (type === 'news') form.elements.namedItem('body_html').value = $('#article-editor').innerHTML; const data = formObject(form); data.featured = form.elements.namedItem('featured').checked; data.published = form.elements.namedItem('published').checked; const id = data.id; delete data.id; try { await api(`/api/admin/${type}${id ? `/${id}` : ''}`, { method:id ? 'PUT' : 'POST', body:JSON.stringify(data) }); form.hidden = true; status(`${type === 'news' ? 'STORY' : 'EVENT'} SAVED`); await loadContent() } catch (error) { status(error.message, true) } }
$('#event-form').addEventListener('submit', (event) => saveRecord(event, 'events'))
$('#news-form').addEventListener('submit', (event) => saveRecord(event, 'news'))
$('#venue-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const data = formObject(form)
  const image = form.elements.namedItem('image').files[0]
  const existingId = data.id
  delete data.id; delete data.image
  data.featured = form.elements.namedItem('featured').checked
  data.published = form.elements.namedItem('published').checked
  try {
    const saved = await api(`/api/admin/venues${existingId ? `/${existingId}` : ''}`, { method: existingId ? 'PUT' : 'POST', body: JSON.stringify(data) })
    const id = existingId || saved.id
    if (image) await api(`/api/admin/venues/${id}/image`, { method: 'PUT', headers: { 'Content-Type': image.type }, body: image })
    form.hidden = true
    status('VENUE SAVED')
    await loadContent()
  } catch (error) { status(error.message, true); await loadContent() }
})
$('#venue-image').addEventListener('change', (event) => {
  const file = event.currentTarget.files[0]
  if (!file) return
  const preview = $('#venue-image-preview')
  preview.src = URL.createObjectURL(file)
  preview.hidden = false
  $('#venue-image-empty').hidden = true
})
$('#remove-venue-image').addEventListener('click', async () => {
  const id = $('#venue-form [name="id"]').value
  if (!id || !confirm('Remove this venue image?')) return
  try { await api(`/api/admin/venues/${id}/image`, { method: 'DELETE' }); status('VENUE IMAGE REMOVED'); await loadContent(); openEditor('venue', content.venues.find((item) => item.id === Number(id))) }
  catch (error) { status(error.message, true) }
})
$('#submission-editor').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget; const data = formObject(form); const id = data.id; delete data.id
  data.reviewed = form.elements.namedItem('reviewed').checked
  try { await api(`/api/admin/submissions/${id}`, { method:'PUT', body:JSON.stringify(data) }); form.hidden = true; status('SUBMISSION SAVED'); await loadSubmissions() }
  catch (error) { status(error.message, true) }
})
$('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget; const data = formObject(form); const id = data.id; delete data.id
  try { await api(`/api/admin/users${id ? `/${id}` : ''}`, { method:id ? 'PUT' : 'POST', body:JSON.stringify(data) }); form.hidden = true; status(`OPERATOR ${id ? 'UPDATED' : 'CREATED'}`); await loadContent() }
  catch (error) { status(error.message, true) }
})
$('#api-key-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  try {
    const result = await api('/api/admin/show-api-keys', { method: 'POST', body: JSON.stringify(formObject(form)) })
    form.hidden = true
    $('#api-key-token').value = result.token
    $('#api-key-result').hidden = false
    status('API KEY GENERATED — COPY THE SECRET NOW')
    await loadContent()
  } catch (error) { status(error.message, true) }
}) // Requests server-generated secret material and places it only in the one-time reveal panel.
$('#copy-api-key').addEventListener('click', async () => {
  const input = $('#api-key-token')
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(input.value)
    else { input.select(); document.execCommand('copy'); input.setSelectionRange(0, 0) }
    status('API KEY COPIED — STORE AND SEND IT SECURELY')
  } catch { status('COPY FAILED — SELECT THE TOKEN AND COPY IT MANUALLY', true) }
}) // Copies the one-time token through the secure Clipboard API with a compatibility fallback.
$('#dismiss-api-key').addEventListener('click', () => {
  $('#api-key-token').value = ''
  $('#api-key-result').hidden = true
  status('ONE-TIME SECRET CLEARED')
}) // Removes the plaintext secret from the page once the administrator confirms it was saved.
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button'); if (!button) return
  if (button.dataset.editEvent) openEditor('event', content.events.find((item) => item.id === Number(button.dataset.editEvent)))
  if (button.dataset.editVenue) openEditor('venue', content.venues.find((item) => item.id === Number(button.dataset.editVenue)))
  if (button.dataset.editNews) openEditor('news', content.news.find((item) => item.id === Number(button.dataset.editNews)))
  if (button.dataset.editUser) openUserEditor(content.admins.find((item) => item.id === Number(button.dataset.editUser)))
  if (button.dataset.editSubmission) openSubmissionEditor(content.submissions.find((item) => item.id === Number(button.dataset.editSubmission)))
  if (button.dataset.publishSubmission) {
    try { await api(`/api/admin/submissions/${button.dataset.publishSubmission}/promote`, { method:'POST', body:'{}' }); status('EVENT PUBLISHED'); await loadContent() }
    catch (error) { status(error.message, true) }
  }
  if (button.dataset.editEventFromSubmission) {
    document.querySelector('nav button[data-view="events"]').click()
    openEditor('event', content.events.find((item) => item.id === Number(button.dataset.editEventFromSubmission)))
  }
  if (button.dataset.reviewSubmission) { try { await api(`/api/admin/submissions/${button.dataset.reviewSubmission}/reviewed`, { method:'PUT', body:JSON.stringify({ reviewed: button.dataset.reviewed !== 'true' }) }); status('SUBMISSION SAVED'); await loadContent() } catch (error) { status(error.message, true) } }
  if (button.dataset.revokeApiKey && confirm('Revoke this API key immediately? This cannot be undone.')) {
    try { await api(`/api/admin/show-api-keys/${button.dataset.revokeApiKey}`, { method: 'DELETE' }); status('API KEY REVOKED'); await loadContent() }
    catch (error) { status(error.message, true) }
  }
  const type = button.dataset.deleteEvent ? 'events' : button.dataset.deleteVenue ? 'venues' : button.dataset.deleteNews ? 'news' : button.dataset.deleteUser ? 'users' : button.dataset.deleteSubmission ? 'submissions' : null
  const id = button.dataset.deleteEvent || button.dataset.deleteVenue || button.dataset.deleteNews || button.dataset.deleteUser || button.dataset.deleteSubmission
  if (type && id && confirm('Permanently delete this record?')) { try { await api(`/api/admin/${type}/${id}`, { method:'DELETE' }); status('RECORD DELETED'); await loadContent() } catch (error) { status(error.message, true) } }
})
api('/api/admin/session').then(setAuthenticated).catch(() => {})
window.setInterval(() => { if (!document.hidden && !$('#submissions-view').hidden) void loadSubmissions() }, 15_000)
