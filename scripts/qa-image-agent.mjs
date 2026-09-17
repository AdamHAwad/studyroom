import fs from 'node:fs';
const { course } = JSON.parse(fs.readFileSync('data/qa/receipt.json'));
const sources = JSON.parse(fs.readFileSync('data/qa/file-results.json'));
const source = sources.find((s) => s.name === 'geometry.pdf');
const response = await fetch('http://localhost:3211/api/jobs/set', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    courseId: course.id,
    title: 'Recognizing shapes',
    sourceIds: [source.id],
    instructions:
      'Include a visual identification question using the unlabeled diagram if the diagram is legible. Keep text cards concise.',
  }),
});
const job = await response.json();
fs.writeFileSync('data/qa/image-job.json', JSON.stringify(job, null, 2));
console.log(JSON.stringify({ id: job.id, status: job.status }));
