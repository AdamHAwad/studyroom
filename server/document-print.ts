import type { StudyDocument, RetrievalTerm, ExamQuestion } from '../src/types';
import katex from 'katex';

export const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
function rich(value: string) {
  return String(value || '')
    .split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g)
    .map((part) => {
      if (part.startsWith('$') && part.endsWith('$')) {
        const displayMode = part.startsWith('$$');
        return katex.renderToString(part.slice(displayMode ? 2 : 1, displayMode ? -2 : -1), {
          throwOnError: false,
          trust: false,
          output: 'mathml',
          displayMode,
        });
      }
      return escapeHtml(part)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
    })
    .join('');
}
export type PacketRow = { terms: RetrievalTerm[]; topic: string };
export function packetPages(terms: RetrievalTerm[]) {
  const topics = new Map<string, RetrievalTerm[]>();
  for (const term of terms)
    topics.set(term.topic || 'Key concepts', [
      ...(topics.get(term.topic || 'Key concepts') || []),
      term,
    ]);
  const rows: PacketRow[] = [];
  for (const [topic, group] of topics) {
    const used = new Set<RetrievalTerm>();
    for (const term of group) {
      if (used.has(term)) continue;
      used.add(term);
      const pair = group.find(
        (other) =>
          !used.has(other) &&
          (term.compareWith.toLowerCase() === other.term.toLowerCase() ||
            other.compareWith.toLowerCase() === term.term.toLowerCase()),
      );
      if (pair) used.add(pair);
      rows.push({ topic, terms: pair ? [term, pair] : [term] });
    }
  }
  const pages: PacketRow[][] = [];
  for (let i = 0; i < rows.length; i += 4) pages.push(rows.slice(i, i + 4));
  return pages;
}
const short = (value: string, max: number) =>
  value.length <= max ? value : value.slice(0, max).replace(/\s+\S*$/, '') + '…';
const lines = (count: number) =>
  `<div class="writing-lines">${'<div></div>'.repeat(Math.max(0, Math.min(18, Math.round(count))))}</div>`;
function termBox(term: RetrievalTerm, answers: boolean) {
  return `<div class="term-box"><div class="term-label"><strong>${rich(term.term)}:</strong> ${rich(term.definition)}</div>${
    answers
      ? `<p><b>Definition</b><br>${rich(term.definition)}</p><p><b>Example</b><br>${rich(term.example)}</p>`
      : '<div class="recall-label">Explain it in your own words</div>' +
        lines(2) +
        '<div class="recall-label">Your example or personal connection</div>' +
        lines(2)
  }${term.memoryAid ? `<div class="memory-aid">Memory aid: ${rich(short(term.memoryAid, 100))}</div>` : ''}</div>`;
}
function questionHtml(
  q: ExamQuestion,
  index: number,
  answers: boolean,
  evidence: StudyDocument['content']['evidence'],
) {
  const visual = evidence.find((e) => e.ref === q.visualRef && e.assetId);
  const citations = q.refs.map((ref) => evidence.find((e) => e.ref === ref)).filter(Boolean);
  return `<article class="exam-question"><div class="question-heading"><b>${index}.</b><div>${rich(q.prompt.replace(/^\s*\d+[.)]\s+/, ''))}</div>${q.points ? `<small>[${q.points} ${q.points === 1 ? 'point' : 'points'}]</small>` : ''}</div>${q.stimulus ? `<div class="stimulus">${rich(q.stimulus)}</div>` : ''}${visual ? `<figure><img src="/api/assets/${escapeHtml(visual.assetId)}" alt="Question figure" /></figure>` : ''}${q.options.length ? `<ol class="options" type="A">${q.options.map((o) => `<li>${rich(o.replace(/^\s*[A-Z][.)]\s+/, ''))}</li>`).join('')}</ol>` : ''}${answers ? `<div class="answer"><b>Answer</b> ${rich(q.answer)}<p>${rich(q.explanation)}</p>${citations.length ? `<small>Sources: ${citations.map((e) => escapeHtml(e!.name + ' · ' + e!.locator)).join('; ')}</small>` : ''}</div>` : lines(q.lines)}${q.parts.map((p) => `<div class="question-part"><b>${rich(p.label)}</b> ${rich(p.prompt)} ${p.points ? `<small>[${p.points} points]</small>` : ''}${answers ? `<div class="answer">${rich(p.answer)}</div>` : lines(p.lines)}</div>`).join('')}</article>`;
}
export function renderDocument(doc: StudyDocument, courseName: string, answers = false) {
  const isPacket = doc.kind === 'retrieval-packet';
  const pages = packetPages(doc.content.terms);
  const header = `<div class="page-top"><span>${escapeHtml(courseName)}</span><span>Name: ________________________ &nbsp; Date: __________</span></div>`;
  const footer = (index: number, total: number) =>
    `<footer>${escapeHtml(doc.title)} <span>${answers ? 'Answer key · ' : ''}${index} / ${total}</span></footer>`;
  let body = '';
  if (isPacket && !answers) {
    const total = pages.length + 1;
    body = `<section class="sheet cover">${header}<h1>RETRIEVAL GUIDE</h1><h2>${escapeHtml(doc.title)}</h2><p class="directions">Read the brief definition, then cover it and explain the idea in your own words. Add an example or personal connection. Check your work afterward and revisit the terms you missed.</p><div class="overview-grid"><div><h3>CONCEPTUAL UNDERSTANDINGS</h3><ol>${doc.content.overview
      .slice(0, 4)
      .map((s) => `<li>${rich(short(s, 230))}</li>`)
      .join('')}</ol></div><div><h3>ESSENTIAL QUESTIONS</h3><ol>${doc.content.essentialQuestions
      .slice(0, 4)
      .map((s) => `<li>${rich(short(s, 230))}</li>`)
      .join(
        '',
      )}</ol></div></div><div class="cover-practice"><h3>Before you begin</h3><p>What do you already remember about this unit?</p>${lines(3)}<h3>After you finish</h3><p>Which ideas need another round of retrieval?</p>${lines(2)}</div>${footer(1, total)}</section>`;
    body += pages
      .map(
        (rows, i) =>
          `<section class="sheet worksheet">${header}<h2>${escapeHtml([...new Set(rows.map((r) => r.topic))].join(' · '))}</h2><div class="packet-rows">${rows.map((row, j) => `<div class="packet-row">${j === 0 || rows[j - 1].topic !== row.topic ? `<h3>${escapeHtml(row.topic)}</h3>` : ''}<div class="term-columns">${row.terms.map((t) => termBox(t, false)).join('')}</div></div>`).join('')}</div>${footer(i + 2, total)}</section>`,
      )
      .join('');
  } else if (isPacket) {
    body = `<main class="answer-document">${header}<h1>${escapeHtml(doc.title)}</h1><h2>Retrieval packet answer key</h2><p>Examples illustrate the concept. Your own accurate examples are equally useful.</p>${doc.content.terms.map((t) => `<article class="key-term"><h3>${escapeHtml(t.topic)} · ${rich(t.term)}</h3>${termBox(t, true)}</article>`).join('')}</main>`;
  } else {
    let number = 0;
    const points = doc.content.sections.reduce(
      (n, s) =>
        n +
        s.questions.reduce(
          (sum, q) => sum + (q.points || q.parts.reduce((p, part) => p + part.points, 0)),
          0,
        ),
      0,
    );
    body = `<main class="exam-document ${doc.content.style.font === 'serif' ? 'serif' : ''} ${doc.content.style.headingCase === 'uppercase' ? 'uppercase' : ''} ${doc.content.style.optionLayout === 'inline' ? 'inline-options' : ''}">${header}<h1>${escapeHtml(doc.title)}</h1><div class="exam-meta">${answers ? 'ANSWER KEY' : 'PRACTICE EXAM'}${doc.content.durationMinutes ? ` · ${doc.content.durationMinutes} minutes` : ''}${points ? ` · ${points} points` : ''}</div><p class="exam-directions">${rich(doc.content.examInstructions)}</p>${doc.content.sections.map((s) => `<section class="exam-section"><h2>${escapeHtml(s.title)}</h2><p>${rich(s.instructions)}</p><div class="exam-questions ${doc.content.style.columns === 2 ? 'two-columns' : ''}">${s.questions.map((q) => questionHtml(q, ++number, answers, doc.content.evidence)).join('')}</div></section>`).join('')}</main>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(doc.title)}${answers ? ' - Answer key' : ''}</title><style>
*{box-sizing:border-box}body{margin:0;background:#e9e9ed;color:#161616;font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.35}h1,h2,h3,p{margin-top:0}h1{font-size:20pt;font-weight:500;text-align:center;margin-bottom:8pt}h2{font-size:15pt;text-align:center;font-weight:500}h3{font-size:10pt}ol{padding-left:20px}li{padding-left:3px}math{max-width:100%;overflow-wrap:anywhere}.print-toolbar{position:sticky;top:0;background:#fff;z-index:5;padding:12px 20px;display:flex;gap:20px;align-items:center;border-bottom:1px solid #ddd;font-size:13px}.print-toolbar button{border:0;background:#4255ff;color:white;padding:10px 18px;border-radius:8px;cursor:pointer;font:inherit}.print-toolbar span{color:#555}.sheet{width:8.5in;height:11in;margin:24px auto;background:white;padding:.5in;position:relative;overflow-wrap:anywhere}.page-top{font-size:8pt;display:flex;justify-content:space-between;gap:10px;margin-bottom:24pt}.page-top span:first-child{max-width:38%}footer{position:absolute;bottom:.25in;left:.5in;right:.5in;display:flex;justify-content:space-between;font-size:8pt;border-top:1px solid #999;padding-top:5pt}.directions{margin:24pt 0;font-size:10pt}.overview-grid{display:grid;grid-template-columns:1fr 1fr;border:1px solid #555;margin-top:24pt}.overview-grid>div{padding:10pt}.overview-grid>div+div{border-left:1px solid #555}.overview-grid h3{font-size:9pt;border-bottom:1px solid #777;padding-bottom:5pt}.overview-grid ol{margin:0;font-size:10pt}.overview-grid li{margin-bottom:10pt}.cover-practice{margin-top:24pt}.cover-practice h3{margin-bottom:4pt}.cover-practice p{font-size:10pt;margin-bottom:4pt}.writing-lines>div{border-bottom:1px solid #ccc;height:.24in}.worksheet .page-top{margin-bottom:10pt}.worksheet h2{font-size:12pt;margin-bottom:10pt}.packet-rows{height:8.75in;display:flex;flex-direction:column}.packet-row{flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid #666}.packet-row+.packet-row{border-top:0}.packet-row h3{text-align:center;background:#f3f3f3;margin:0;font-size:9pt;border-bottom:1px solid #666;padding:3pt}.term-columns{display:flex;flex:1;min-height:0}.term-box{padding:7pt;flex:1;min-width:0}.term-columns .term-box{display:flex;flex-direction:column;min-height:0}.term-columns .term-box .writing-lines{display:flex;flex-direction:column;flex:1;min-height:0}.term-columns .term-box .writing-lines>div{height:auto;flex:1;min-height:0}.term-columns .term-label,.term-columns .memory-aid,.term-columns .recall-label{flex-shrink:0}.term-columns .term-box+.term-box{border-left:1px solid #666}.term-label{font-size:10pt;line-height:1.2}.term-label span{display:block;font-size:8pt;margin-top:2pt}.recall-label{font-size:8pt;color:#555;margin-top:6pt}.memory-aid{font-size:8pt;margin-top:6pt}.answer-document,.exam-document{background:#fff;width:8.5in;margin:24px auto;padding:.5in;overflow-wrap:anywhere}.key-term{break-inside:avoid;border-bottom:1px solid #999;padding:12pt 0}.key-term h3{margin:0}.key-term .term-label{display:none}.serif{font-family:'Times New Roman',serif}.uppercase .exam-section h2{text-transform:uppercase}.exam-meta{text-align:center;font-size:10pt;margin:12pt 0 20pt}.exam-directions{margin-bottom:24pt}.exam-section h2{text-align:left;font-size:13pt;border-bottom:1px solid #555;padding-bottom:5pt;break-after:avoid}.exam-section>p{font-size:10pt;break-after:avoid}.exam-question{break-inside:avoid;margin-bottom:20pt}.question-heading{display:flex;gap:8pt;align-items:baseline}.question-heading>div{flex:1}.question-heading small{white-space:nowrap}.options{padding-left:35pt}.options li{margin:6pt 0}.inline-options .options{display:flex;flex-wrap:wrap;gap:8pt 28pt}.stimulus{white-space:normal;border-left:2px solid #aaa;padding:10pt;margin:10pt 0;font-size:10pt}.answer{background:#f4f4f4;padding:10pt;margin:10pt 0;font-size:10pt}.answer p{margin:6pt 0 0}.exam-question figure{margin:12pt 0;text-align:center}.exam-question img{max-width:100%;max-height:3in;object-fit:contain}.question-part{margin:12pt 0 0 20pt}.two-columns{column-count:2;column-gap:24pt}.two-columns .exam-question{font-size:10pt}.two-columns .question-heading{gap:5pt}.two-columns .question-heading small{white-space:normal}
@page{size:letter portrait;margin:.5in}@media print{body{background:white}.print-toolbar{display:none}.sheet{width:7.5in;height:10in;margin:0;padding:0;break-after:page}.sheet:last-child{break-after:auto}.sheet footer{left:0;right:0;bottom:0}.answer-document,.exam-document{width:auto;margin:0;padding:0}.packet-row h3,.answer{-webkit-print-color-adjust:exact;print-color-adjust:exact}a{color:inherit;text-decoration:none}}
@media screen{.sheet,.answer-document,.exam-document{zoom:var(--screen-zoom,1)}}@media screen and (max-width:850px){.sheet,.answer-document,.exam-document{margin:12px auto}.print-toolbar span{display:none}}
</style></head><body><div class="print-toolbar"><button onclick="window.print()">Print / Save PDF</button><span>${isPacket && !answers ? `${pages.length + 1} pages · Print double-sided, flip on the long edge.` : answers ? 'Answer key. Print separately after completing your work.' : 'Print without the answer key to practice on paper.'} Use Letter paper at 100% scale. Turn off browser headers and footers.</span></div>${body}<script>function fitPreview(){document.documentElement.style.setProperty('--screen-zoom',String(Math.min(1,(window.innerWidth-24)/816)))}fitPreview();window.addEventListener('resize',fitPreview);</script></body></html>`;
}
