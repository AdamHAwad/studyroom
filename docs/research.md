# Research and implementation decisions

Research date: 10 September 2026.

## Quizlet reference

Inspected Quizlet's public Flashcards and Learn product pages in a browser, including the actual product-demo image. The visual reference includes a white navigation bar, blue action buttons, a pale gray study background, rounded white cards, restrained borders, term/definition pairs, and answer options with green feedback. A live public set led to a human-verification gate. The implementation therefore follows accessible official demos and documented flows. It is not a verified pixel-for-pixel copy of every authenticated screen. The name and illustrations are original.

- https://quizlet.com/features/flashcards documents flipping, creating/importing, and starring cards.
- https://quizlet.com/features/learn shows the multiple-choice answer treatment and question-type controls.
- https://help.quizlet.com/hc/en-ca/articles/360030988091-Studying-with-Flashcards describes keyboard arrows, click-to-flip, autoplay, shuffle, orientation, sorting, and speech.
- https://help.quizlet.com/hc/en-us/articles/360030986971-Studying-with-Learn describes adaptive sessions, question types, and starred terms.
- https://help.quizlet.com/hc/en-us/articles/360030642972-Studying-with-Test-mode/ describes configurable tests and end-of-test review. Studyroom additionally saves unfinished tests.
- https://quizlet.com/ca/features/studymodes describes timed Match and the four study modes.
- https://quizlet.com/blog/welcome-back-to-school-heres-whats-new-improved documents sorting, progress, and higher-quality MCQs. It is historical context, not evidence of the exact current layout.

Quizlet's proprietary learning model and internal storage design are not public contracts. Studyroom uses its own documented scheduling, storage, and generation system.

## Learning evidence

Karpicke & Roediger, 2008, The Critical Importance of Retrieval for Learning. https://doi.org/10.1126/science.1152408. Continued retrieval after initial success benefits later retention. Product decision: repeated opportunities to retrieve, separate from rereading and self-ratings.

Cepeda et al., 2006, Distributed practice in verbal recall tasks. https://pubmed.ncbi.nlm.nih.gov/16719566/. Spacing has broad support across studies, with effects that depend on timing and retention interval. Product decision: record timestamps and suggest later review. The exact 1/2/4/8/16/30-day rule is an inspectable heuristic, not an experimentally optimized schedule for this student.

Smith & Karpicke, 2014, Retrieval practice with short-answer, multiple-choice, and hybrid tests. https://pubmed.ncbi.nlm.nih.gov/24059563/. Their experiments do not support a universal claim that written retrieval outperforms MCQs. Product decision: support both formats and preserve their distinct evidence.

Butler, Karpicke & Roediger, 2007, The effect of type and timing of feedback on learning from multiple-choice tests. https://pubmed.ncbi.nlm.nih.gov/18194050/. The study found benefits from delayed feedback under its conditions. Product decision: provide correction after each Learn answer and after the full Test. Neither timing is presented as universally optimal.

NBME, Item-Writing Guide. https://www.nbme.org/sites/default/files/2021-02/NBME_Item%20Writing%20Guide_R_6.pdf. Professional guidance for one-best-answer questions includes a focused lead-in and homogeneous, plausible alternatives. Product decision: schema requires authored distractors for generated sets, followed by uniqueness validation. Human review remains useful for semantic ambiguity.

These sources support study design and item-writing choices. They do not establish that prescribing an AI's private reasoning style produces better educational outcomes. The project skill therefore asks for observable deliverables and an editorial audit, with only a concise coverage statement returned.

## Source images

Diagram selection is a task-design decision: use a visual when the learner needs its structure or data, preserve scales and relevant context, and avoid answer leakage in question-side images. This project does not claim a measured learning advantage for automatically selected diagrams. Each included image retains its source, role, crop, alt text, and an explicit reason so the decision is inspectable.

Johnson & Mayer, 2012, An eye movement analysis of the spatial contiguity effect in multimedia learning, https://pubmed.ncbi.nlm.nih.gov/22309059/. Integrated text/diagram presentations supported transfer in two of three experiments; the third did not reach significance. Image cards therefore keep relevant text adjacent to the image.

Kienitz, Krebs & Eitel, 2023, Seductive details hamper learning even when they do not disrupt, https://pubmed.ncbi.nlm.nih.gov/37362861/. Their experiment supports attention diversion as one mechanism by which irrelevant details can impede recall. This informs the rule that image selection needs a concrete instructional reason. It does not justify a universal ban on engaging visuals.
