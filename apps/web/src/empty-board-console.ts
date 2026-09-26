export function emptyBoardScript(apiBaseUrl: string): string { return `(() => {
  const api = ${JSON.stringify(apiBaseUrl)}, root = document.querySelector('#empty-board-reviews');
  if (!root) return;
  const node = (tag, value) => { const item = document.createElement(tag); item.textContent = String(value ?? ''); return item; };
  const field = (tag, hint) => { const item = document.createElement(tag); item.placeholder = hint; item.required = true; return item; };
  async function decide(path, payload) {
    const sessionResponse = await fetch(api + '/api/v1/session', { credentials: 'include' });
    const session = sessionResponse.ok ? await sessionResponse.json() : {};
    const headers = { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() };
    if (session.csrfToken) headers['x-csrf-token'] = session.csrfToken;
    const response = await fetch(api + path, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(payload) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'decision_failed');
    await load();
  }
  function link(url) { if (!url) return node('span', 'Board URL unavailable; do not approve');
    const item = node('a', url); item.href = url; item.target = '_blank'; item.rel = 'noopener noreferrer'; return item; }
  function reviewCard(review) {
    const card = node('article', ''); card.className = 'operator-card';
    card.append(node('h3', 'Historical board appears empty'), link(review.boardUrl),
      node('p', review.historicalListingCount + ' historical listings · ' + review.connectorId),
      node('p', 'Scan IDs: ' + review.firstScanId + ' / ' + review.secondScanId));
    const evidenceButton = node('button', 'Show ownership evidence IDs'); evidenceButton.type = 'button';
    const evidenceList = node('p', ''); evidenceButton.onclick = async () => {
      try { const response = await fetch(api + '/api/v1/admin/sources/' + review.sourceId + '/evidence', { credentials: 'include' });
        if (!response.ok) throw new Error('unavailable'); const data = await response.json();
        evidenceList.textContent = (data.ownershipEvidence || []).map(item => item.id + ' (' + item.type + ')').join(', ') || 'None';
      } catch { evidenceList.textContent = 'Evidence unavailable; approval blocked.'; } };
    const form = document.createElement('form'); form.className = 'empty-board-form';
    const url = field('input', 'Current employer-owned careers-page URL'); url.type = 'url';
    const evidenceId = field('input', 'Ownership evidence UUID');
    const reason = field('textarea', 'Reason and exact link verification'); reason.minLength = 8; reason.maxLength = 1000;
    const attestLabel = node('label', ''); const attest = field('input', ''); attest.type = 'checkbox';
    attestLabel.append(attest, node('span', 'I checked the current employer-owned page links to this exact ATS board.'));
    const confirm = node('button', 'Confirm empty board'); confirm.type = 'submit';
    const reject = node('button', 'Reject review'); reject.type = 'button';
    const status = node('p', ''); status.setAttribute('role', 'status');
    form.append(url, evidenceId, reason, attestLabel, confirm, reject, status);
    form.onsubmit = async event => { event.preventDefault(); try { await decide('/api/v1/admin/empty-boards/reviews/' + review.id + '/confirm', {
      firstScanId: review.firstScanId, secondScanId: review.secondScanId, ownershipEvidenceId: evidenceId.value.trim(),
      employerCareersUrl: url.value.trim(), attestsExactBoardLink: true, reason: reason.value.trim() }); }
      catch (error) { status.textContent = 'Not recorded: ' + error.message; } };
    reject.onclick = async () => { if (reason.value.trim().length < 8) { status.textContent = 'Give a reason of at least eight characters.'; return; }
      try { await decide('/api/v1/admin/empty-boards/reviews/' + review.id + '/reject', { reason: reason.value.trim() }); }
      catch (error) { status.textContent = 'Not recorded: ' + error.message; } };
    card.append(evidenceButton, evidenceList, form); return card;
  }
  function confirmationCard(item) {
    const card = node('article', ''); card.className = 'operator-card';
    card.append(node('h3', 'Confirmed empty · ' + item.inventoryState), link(item.boardUrl),
      node('p', 'Health ' + item.healthState + ' · ' + item.heldListingCount + ' held listings · expires ' + new Date(item.validUntil).toLocaleString()));
    if (item.heldListingCount > 0) { const form = document.createElement('form'); form.className = 'empty-board-form';
      const reason = field('textarea', 'Separate reason for permanently closing held listings'); reason.minLength = 8; reason.maxLength = 1000;
      const button = node('button', 'Request bulk closure'); button.type = 'submit';
      const status = node('p', 'Requires two post-approval empty scans at least 30 minutes apart.'); status.setAttribute('role', 'status');
      form.append(reason, button, status); form.onsubmit = async event => { event.preventDefault();
        try { await decide('/api/v1/admin/empty-boards/sources/' + item.sourceId + '/close', {
          confirmationId: item.confirmationId, expectedListingCount: item.heldListingCount, reason: reason.value.trim() }); }
        catch (error) { status.textContent = 'Not recorded: ' + error.message; } }; card.append(form); }
    return card;
  }
  async function load() { try { const response = await fetch(api + '/api/v1/admin/empty-boards/reviews', { credentials: 'include' });
    if (!response.ok) throw new Error('unavailable'); const data = await response.json();
    const cards = [...(data.reviews || []).map(reviewCard), ...(data.confirmations || []).map(confirmationCard)];
    root.replaceChildren(...(cards.length ? cards : [node('p', 'No pending empty-board reviews or active confirmations.')]));
  } catch { root.replaceChildren(node('p', 'Empty-board review queue unavailable. No decision was attempted.')); } }
  load();
})();`; }
