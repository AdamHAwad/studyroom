import fs from 'node:fs';
const base = 'http://localhost:3211/api';
async function post(p, b) {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error);
  return d;
}
const course = await post('/courses', {
  name: 'Learning science · test course',
  code: 'DEMO 101',
  color: 'purple',
});
const body = new FormData();
body.append('file', new Blob([fs.readFileSync('tests/fixtures/lecture.txt')]), 'lecture.txt');
const source = await (
  await fetch(base + '/courses/' + course.id + '/upload', { method: 'POST', body })
).json();
const job = await post('/jobs/set', {
  courseId: course.id,
  title: 'Memory and learning',
  sourceIds: [source.id],
  instructions:
    'Create a compact set covering the core distinctions. This is an end-to-end verification using a short synthetic lecture.',
});
fs.writeFileSync('data/qa/receipt.json', JSON.stringify({ course, source, job }, null, 2));
console.log(JSON.stringify({ courseId: course.id, sourceStatus: source.status, jobId: job.id }));
