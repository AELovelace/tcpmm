const form = document.querySelector('#submission-form')
const status = document.querySelector('#submission-status')
const button = form.querySelector('button[type="submit"]')
let formToken = ''

const loadToken = async () => {
  button.disabled = true
  button.textContent = 'LOADING SECURE FORM…'
  try {
    const response = await fetch('/api/show-submissions/form-token', { cache: 'no-store' })
    if (!response.ok) throw new Error('Form service unavailable')
    const data = await response.json()
    formToken = data.token
    button.disabled = false
    button.textContent = 'SEND TO CONTROL ↗'
  } catch (error) {
    status.textContent = error.message
    button.textContent = 'FORM UNAVAILABLE'
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  button.disabled = true
  button.textContent = 'TRANSMITTING…'
  status.textContent = ''
  status.classList.remove('success')
  try {
    const payload = Object.fromEntries(new FormData(form).entries())
    payload.form_token = formToken
    const response = await fetch('/api/show-submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const data = await response.json()
    if (!response.ok || !data.received) throw new Error(data.error || 'Submission could not be sent')
    form.reset()
    formToken = ''
    status.textContent = 'RECEIVED // THE CREW WILL REVIEW YOUR SHOW.'
    status.classList.add('success')
    await loadToken()
  } catch (error) {
    status.textContent = error.message
    formToken = ''
    await loadToken()
  }
})

void loadToken()
