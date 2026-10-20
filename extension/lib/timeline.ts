// Renders one task's audit trail (used by the History tab and the auditor dashboard).
import { screenshotUrl } from './api';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function line(e: any): string {
  const p = e.payload;
  switch (e.event_type) {
    case 'user_message': return `User asked: “${esc(p.prompt)}” <span class="muted">(model ${esc(p.model)})</span>`;
    case 'page_snapshot': return `Saw page <span class="muted">${esc(p.title)} · ${esc(e.url)}</span>`;
    case 'model_action': {
      const a = p.action;
      const what = a.action === 'fill_form' ? `fill_form ${(a.fields || []).map((f: any) => `[${f.id}] “${esc(f.value)}”`).join(', ')}`
        : a.value !== undefined ? `${a.action} “${esc(a.value)}”` : a.action;
      const on = p.element ? ` on “${esc(p.element.label || p.element.text)}”` : a.url ? ` ${esc(a.url)}` : '';
      const q = a.question ? `: “${esc(a.question)}”` : a.summary ? `: ${esc(a.summary)}` : '';
      const who = p.source === 'workflow' ? 'Replayed workflow step' : 'Model decided';
      return `${who}: <b>${what}</b>${on}${p.element?.row ? ` <span class="muted">(row ${esc(p.element.row)})</span>` : ''}${q}` +
        `${p.needs_confirmation ? ' <b>(needs confirmation)</b>' : ''}` +
        `<div class="muted small">${esc(a.thought)} · ${esc(p.model)}</div>`;
    }
    case 'action_result': return (p.ok ? `Result: ok <span class="muted">${esc(p.detail)}</span>` : `<span class="error">Result: ${esc(p.error)}</span>`) +
      (p.observed ? ` <span class="muted">· ${esc(p.observed)}</span>` : '');
    case 'user_answer': return `User answered “${esc(p.answer)}” <span class="muted">(${esc(p.field)})</span>`;
    case 'profile_learned': return `Saved to profile: ${esc(p.field)} = ${esc(p.value)}`;
    case 'confirmation': return (p.approved ? `<b>User CONFIRMED</b> “${esc(p.button)}”` : `<b class="error">User DECLINED</b> “${esc(p.button)}”`) +
      (p.site_dialog ? ` <span class="muted">(the site asked: “${esc(p.site_dialog)}”)</span>` : '') +
      `<div class="small">${(p.fields || []).map((f: any) => `${esc(f.label)}: <b>${esc(f.value)}</b>` +
        (f.source ? ` <span class="${f.guess ? 'error' : 'muted'}">(${esc(f.source)})</span>` : '')).join(' · ')}</div>` +
      ((p.checks || []).length ? `<div class="error small">Checks: ${(p.checks || []).map(esc).join(' ')}</div>` : '');
    case 'plan': return `Plan: ${(p.steps || []).map((x: string, i: number) => `${i + 1}. ${esc(x)}`).join(' ')}`;
    case 'workflow_selected': return `Following a workflow seen before: <b>${esc(p.label)}</b>`;
    case 'workflow_drift': return `<span class="error">The workflow no longer matches the site; the model takes over</span>`;
    case 'experience_saved': return `Learned how this was done (experience #${esc(p.experience)})`;
    case 'presubmit_mismatch': return `<span class="error">Pre-submit check:</span> ${esc(p.note)}`;
    case 'site_dialog': return `The site asked: “${esc(p.message)}”`;
    case 'signed_out_detected': return `<span class="error">The site signed the user out</span>; will resume at ${esc(p.resume_at)}`;
    case 'file_chosen': return `User attached a file: ${esc(p.name)} (${esc(p.bytes)} bytes)`;
    case 'screenshot': return `Screenshot (${esc(p.moment)})`;
    case 'model_error': return `<span class="error">Model error: ${esc(p.error)}</span>${p.fallback ? ` → fell back to ${esc(p.fallback)}` : ''}`;
    case 'task_finished': return `Finished: <b>${esc(p.status)}</b> — ${esc(p.summary)}`;
    default: return `${esc(e.event_type)} ${esc(JSON.stringify(p))}`;
  }
}

export async function renderTimeline(container: HTMLElement, detail: { task: any; events: any[] }) {
  const t = detail.task;
  container.innerHTML =
    `<h3>${esc(t.prompt)}</h3><p class="muted small">${esc(t.user_name)} (${esc(t.emp_id)}) · ${esc(t.started_at)} · ` +
    `<span class="badge ${esc(t.status)}">${esc(t.status)}</span> · ${esc(t.model)} @ ${esc(t.model_url)} · IP ${esc(t.client_ip)}</p>` +
    `<ol class="timeline">${detail.events
      .map((e) => `<li data-type="${esc(e.event_type)}"><span class="muted small">${esc(e.created_at.slice(11, 19))}</span> ${line(e)}` +
        (e.screenshot ? `<div><img data-shot="${esc(e.screenshot)}" alt="screenshot"></div>` : '') + '</li>')
      .join('')}</ol>`;
  for (const img of container.querySelectorAll<HTMLImageElement>('img[data-shot]')) {
    img.src = await screenshotUrl(img.dataset.shot!);
  }
}

export { esc };
