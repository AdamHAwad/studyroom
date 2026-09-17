import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { put, all, DATA } from '../server/db.ts';
import type { Attempt, CardProgress, Source, StudySet, Course, Card } from '../src/types.ts';
import { advance } from '../server/learning.ts';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260917);
const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
const chance = (p: number) => rand() < p;
const DAY = 86400000;
const nowMs = Date.now();

function ts(daysAgo: number, minutesAfter = 0): string {
  return new Date(
    Math.min(nowMs - daysAgo * DAY + minutesAfter * 60000, nowMs - 15000),
  ).toISOString();
}

type Draft = {
  term: string;
  definition: string;
  question?: string;
  distractors?: string[];
  explanation?: string;
  topic?: string;
  aliases?: string[];
  quote?: string;
};

const bioCellDrafts: Draft[] = [
  {
    term: 'Nucleus',
    definition:
      'The membrane-bound organelle that stores DNA and directs cell activities such as growth and reproduction.',
    question:
      "Which organelle contains the cell's genetic material and acts as its control center?",
    distractors: ['Ribosome', 'Mitochondrion', 'Golgi apparatus'],
    explanation:
      'The nuclear envelope separates chromatin from the cytoplasm, so transcription starts there before mRNA exits through pores.',
    topic: 'Organelles',
    quote:
      "The nucleus stores DNA in the form of chromatin and acts as the cell's control center, directing growth and reproduction.",
  },
  {
    term: 'Ribosome',
    definition: 'The structure that assembles amino acids into proteins by reading messenger RNA.',
    question: 'Where in the cell are proteins assembled?',
    distractors: ['Nucleus', 'Lysosome', 'Central vacuole'],
    explanation:
      'Ribosomes either float free in the cytosol or stud the rough ER; either way they translate mRNA into polypeptides.',
    topic: 'Organelles',
    quote:
      'Ribosomes read messenger RNA and link amino acids into proteins, floating free or attached to the rough ER.',
  },
  {
    term: 'Rough endoplasmic reticulum',
    definition:
      'The membrane network studded with ribosomes that folds and modifies proteins bound for membranes or secretion.',
    question: 'Which organelle finishes proteins that will be shipped out of the cell?',
    distractors: ['Smooth endoplasmic reticulum', 'Nucleolus', 'Peroxisome'],
    explanation:
      'Ribosomes on its surface insert new polypeptides into its lumen, where they fold and gain sugar tags.',
    topic: 'Organelles',
    aliases: ['rough ER', 'RER'],
  },
  {
    term: 'Smooth endoplasmic reticulum',
    definition:
      'The membrane network that builds lipids, detoxifies compounds, and stores calcium ions.',
    question: 'Which organelle builds lipids and helps liver cells detoxify compounds?',
    distractors: ['Rough endoplasmic reticulum', 'Mitochondrion', 'Golgi apparatus'],
    explanation: 'No ribosomes dot its surface, which is why it looks smooth under a microscope.',
    topic: 'Organelles',
    aliases: ['smooth ER', 'SER'],
    quote:
      'The smooth ER builds lipids and detoxifies compounds, and it stores calcium ions for muscle cells.',
  },
  {
    term: 'Golgi apparatus',
    definition:
      'The organelle that modifies, sorts, and packages proteins and lipids for delivery.',
    question:
      'Which organelle acts like a shipping department, tagging products for their destinations?',
    distractors: ['Lysosome', 'Nucleolus', 'Cytoskeleton'],
    explanation:
      'Vesicles bud off carrying molecular address labels that route them to the membrane or beyond.',
    topic: 'Organelles',
    quote:
      "The Golgi apparatus tags and packages proteins into vesicles for delivery, like the cell's shipping department.",
  },
  {
    term: 'Lysosome',
    definition:
      'The organelle that digests worn-out organelles and large molecules with hydrolytic enzymes.',
    question: "Which organelle recycles the cell's worn-out parts?",
    distractors: ['Ribosome', 'Chloroplast', 'Centriole'],
    explanation: 'Its acidic interior keeps those powerful enzymes contained in one safe place.',
    topic: 'Organelles',
    quote:
      'Lysosomes digest worn-out organelles and large molecules using enzymes that work in an acidic interior.',
  },
  {
    term: 'Mitochondrion',
    definition:
      'The organelle that carries out cellular respiration, converting energy from glucose into ATP.',
    question: "Which organelle produces most of the cell's ATP?",
    distractors: ['Chloroplast', 'Nucleus', 'Vacuole'],
    explanation:
      'It keeps its own DNA, and the folded cristae give the reactions more surface area.',
    topic: 'Organelles',
    aliases: ['mitochondria'],
    quote:
      'Mitochondria convert energy from glucose into ATP during cellular respiration, using folded cristae to fit more reaction space.',
  },
  {
    term: 'Chloroplast',
    definition:
      'The plant organelle that captures light energy to build sugars during photosynthesis.',
    question: 'In which organelle does photosynthesis take place?',
    distractors: ['Mitochondrion', 'Central vacuole', 'Ribosome'],
    explanation: 'Thylakoid membranes stacked into grana hold the chlorophyll that absorbs light.',
    topic: 'Organelles',
    quote:
      'Chloroplasts capture light energy and build sugars, with chlorophyll held in stacked thylakoid membranes called grana.',
  },
  {
    term: 'Central vacuole',
    definition:
      'The large plant-cell compartment that stores water and keeps the cell firm through turgor pressure.',
    question: 'Which structure makes a plant cell rigid and crisp?',
    distractors: ['Lysosome', 'Nucleus', 'Golgi apparatus'],
    explanation:
      'A full central vacuole pushes the membrane against the wall; when it empties, leaves wilt.',
    topic: 'Plant cells',
    quote:
      'The central vacuole stores water, and turgor pressure from a full vacuole keeps plant cells firm.',
  },
  {
    term: 'Plasma membrane',
    definition: 'The phospholipid bilayer that controls what enters and leaves the cell.',
    question: 'Which structure decides which substances can enter or leave the cell?',
    distractors: ['Cell wall', 'Nuclear envelope', 'Cytoskeleton'],
    explanation:
      'It is selectively permeable: small nonpolar molecules slip through, while ions and sugars need transport proteins.',
    topic: 'Membranes',
    aliases: ['cell membrane'],
    quote:
      'The plasma membrane is a selectively permeable bilayer, so small nonpolar molecules pass freely but ions need transport proteins.',
  },
  {
    term: 'Cell wall',
    definition:
      'The rigid outer layer of plant cells, made of cellulose, that provides support and protection.',
    question: 'Which structure gives plant cells their boxy shape?',
    distractors: ['Plasma membrane', 'Capsule', 'Cytoskeleton'],
    explanation:
      'Plant walls are cellulose, fungal walls are chitin, and bacterial walls are peptidoglycan.',
    topic: 'Membranes',
    quote:
      'Plant cell walls are rigid layers of cellulose that support the cell and hold its shape.',
  },
  {
    term: 'Cytoskeleton',
    definition:
      'The network of protein fibers that gives a cell shape, support, and the ability to move.',
    question: 'Which structure anchors organelles and moves vesicles around the cell?',
    distractors: ['Cell wall', 'Plasma membrane', 'Nucleolus'],
    explanation:
      'Microtubules, microfilaments, and intermediate filaments make up its three-part scaffold.',
    topic: 'Cell support',
    quote:
      'The cytoskeleton is a network of microtubules and microfilaments that anchors organelles and moves vesicles.',
  },
  {
    term: 'Nucleoid',
    definition:
      'The region of a prokaryotic cell where the circular chromosome is concentrated, with no surrounding membrane.',
    question: 'Where is DNA found in a prokaryotic cell?',
    distractors: ['Nucleus', 'Central vacuole', 'Nucleolus'],
    explanation:
      'Prokaryotes have no nuclear envelope, so their DNA sits directly in the cytoplasm.',
    topic: 'Prokaryotes vs. eukaryotes',
    quote:
      'Prokaryotic DNA concentrates in the nucleoid, a region of the cytoplasm not enclosed by any membrane.',
  },
  {
    term: 'Peroxisome',
    definition: 'The organelle that breaks down fatty acids and neutralizes hydrogen peroxide.',
    question: 'Which organelle converts toxic hydrogen peroxide into water and oxygen?',
    distractors: ['Lysosome', 'Mitochondrion', 'Smooth endoplasmic reticulum'],
    explanation:
      'Catalase inside the peroxisome finishes the job before the peroxide can damage the cell.',
    topic: 'Organelles',
  },
];

const bioGeneticsDrafts: Draft[] = [
  {
    term: 'Gene',
    definition: 'A DNA sequence that codes for a trait or a functional product.',
    question: 'What is the basic unit of heredity?',
    distractors: ['Protein', 'Enzyme', 'Chromosome'],
    explanation: 'Genes sit at specific loci on chromosomes and can come in different versions.',
    topic: 'Genes',
  },
  {
    term: 'Allele',
    definition:
      'One of the alternative versions of a gene, such as purple versus white flower color.',
    question: 'What do we call one specific version of a gene?',
    distractors: ['Genotype', 'Trait', 'Gamete'],
    explanation: 'Different alleles arise from mutations in the same stretch of DNA.',
    topic: 'Genes',
  },
  {
    term: 'Genotype',
    definition:
      'The combination of alleles an organism carries for a trait, written with letters like Bb.',
    question: "What term describes an organism's genetic makeup?",
    distractors: ['Phenotype', 'Karyotype', 'Pedigree'],
    explanation: 'Genotypes are either homozygous or heterozygous pairs of alleles.',
    topic: 'Genes',
  },
  {
    term: 'Phenotype',
    definition: 'The observable expression of a genotype, such as brown eyes or round seeds.',
    question: 'What do we call the traits you can actually observe?',
    distractors: ['Genotype', 'Allele', 'Test cross'],
    explanation:
      'Two organisms can share a phenotype with different genotypes, like BB and Bb both looking dominant.',
    topic: 'Genes',
  },
  {
    term: 'Homozygous',
    definition: 'Carrying two identical alleles for a gene, either BB or bb.',
    question: 'What term describes two of the same allele paired together?',
    distractors: ['Heterozygous', 'Codominant', 'Polygenic'],
    explanation:
      'Homozygous dominant shows the dominant trait; homozygous recessive shows the recessive trait.',
    topic: 'Inheritance',
  },
  {
    term: 'Heterozygous',
    definition: 'Carrying two different alleles for a gene, like Bb.',
    question: 'What term describes two different alleles paired together?',
    distractors: ['Homozygous', 'True-breeding', 'Recessive'],
    explanation: 'The dominant allele usually masks the recessive one in a heterozygote.',
    topic: 'Inheritance',
  },
  {
    term: 'Dominant allele',
    definition:
      'An allele whose effect appears in the phenotype even when paired with a different allele.',
    question: 'Which kind of allele shows its effect even in a heterozygote?',
    distractors: ['Recessive allele', 'Silent allele', 'Mutant allele'],
    explanation:
      'Dominance is about expression, not strength: the allele sets the phenotype on its own.',
    topic: 'Inheritance',
  },
  {
    term: 'Recessive allele',
    definition: 'An allele that is masked in heterozygotes and only expressed when homozygous.',
    question: 'When can a recessive trait appear in the phenotype?',
    distractors: ['When one copy is present', 'In every generation', 'Only in males'],
    explanation: 'A recessive trait needs both alleles, like bb, so it can skip generations.',
    topic: 'Inheritance',
  },
  {
    term: 'Law of segregation',
    definition:
      "Mendel's finding that the two alleles of a gene separate during gamete formation, so each gamete receives one.",
    question: 'What did Mendel conclude about how allele pairs behave when gametes form?',
    distractors: [
      'Alleles blend together',
      'Alleles always stay paired',
      'Dominant alleles are inherited more often',
    ],
    explanation:
      'Each parent passes on exactly one allele per gene, which is why traits can skip a generation.',
    topic: 'Mendel',
    aliases: ['segregation'],
  },
  {
    term: 'Punnett square',
    definition:
      'A diagram that predicts the genotype and phenotype ratios of offspring from a cross.',
    question: 'What tool predicts the probability of offspring genotypes?',
    distractors: ['Pedigree chart', 'Karyotype', 'Test cross'],
    explanation: 'Each box holds one equally likely combination of gametes.',
    topic: 'Mendel',
  },
  {
    term: 'Incomplete dominance',
    definition:
      'A pattern where the heterozygote shows a blended phenotype, like pink flowers from red and white parents.',
    question:
      'In snapdragons, red crossed with white gives pink flowers. What is this pattern called?',
    distractors: ['Codominance', 'Complete dominance', 'Epistasis'],
    explanation:
      'Neither allele fully masks the other, so the heterozygote lands between the two homozygotes.',
    topic: 'Beyond Mendel',
  },
  {
    term: 'Codominance',
    definition:
      'A pattern where both alleles are fully expressed in a heterozygote, like the AB blood type.',
    question: 'A person with one A allele and one B allele has type AB blood. What is this called?',
    distractors: ['Incomplete dominance', 'Simple dominance', 'Sex linkage'],
    explanation:
      'Both versions show up side by side rather than blending, as with both A and B sugars on red blood cells.',
    topic: 'Beyond Mendel',
  },
];

const gildedAgeDrafts: Draft[] = [
  {
    term: 'Gilded Age',
    definition:
      'The era from about 1870 to 1900 of booming industry, mass immigration, and glaring inequality hidden under a shiny surface.',
    question:
      'What era of booming industry and hidden inequality lasted roughly from 1870 to 1900?',
    distractors: ['The Progressive Era', 'The Reconstruction era', 'The Roaring Twenties'],
    explanation: 'Mark Twain coined the name: a thin gold coat over serious social problems.',
    topic: 'Industrialization',
    quote:
      'Mark Twain called the era "gilded" because a thin layer of gold covered deep social problems beneath the boom.',
  },
  {
    term: 'Transcontinental Railroad',
    definition:
      'The 1869 rail line connecting California to the eastern rail network, built largely by Chinese and Irish laborers.',
    question: 'What 1869 project linked the Pacific coast to the eastern rail network?',
    distractors: ['The Erie Canal', 'The National Road', 'The Oregon Trail'],
    explanation:
      'It met at Promontory Summit, Utah, and cut coast-to-coast travel from months to about a week.',
    topic: 'Industrialization',
    quote:
      'The transcontinental railroad was finished in 1869 at Promontory Summit, built largely by Chinese and Irish laborers.',
  },
  {
    term: 'Homestead Act',
    definition:
      'The 1862 law granting 160 acres of western land to settlers who lived on and farmed it for five years.',
    question: 'Which law gave 160 acres to settlers who farmed it for five years?',
    distractors: ['The Morrill Act', 'The Dawes Act', 'The Pacific Railway Act'],
    explanation:
      'It pulled hundreds of thousands of families west, though much of the best land went to railroads and speculators.',
    topic: 'Westward expansion',
    quote:
      'Under the Homestead Act of 1862, settlers who farmed 160 acres for five years could claim title to the land.',
  },
  {
    term: 'Robber barons',
    definition:
      'A critical label for industrialists like Rockefeller and Carnegie whose fortunes grew through ruthless tactics.',
    question: "What critical label did the era's giant industrialists earn?",
    distractors: ['Captains of industry', 'Muckrakers', 'Carpetbaggers'],
    explanation:
      'Defenders said "captains of industry" for building jobs; critics saw monopoly, union-busting, and bribery.',
    topic: 'Industrialization',
    aliases: ['captains of industry'],
    quote:
      'Critics called men like Rockefeller and Carnegie "robber barons" for building fortunes on ruthless tactics.',
  },
  {
    term: 'Horizontal integration',
    definition:
      'Buying out or merging with competitors in the same industry to control one stage of production.',
    question:
      'Rockefeller bought rival oil refineries until he controlled the market. What strategy is this?',
    distractors: ['Vertical integration', 'Diversification', 'Trust-busting'],
    explanation: 'Standard Oil used it to dominate refining long before the antitrust era.',
    topic: 'Big business',
    quote:
      'Horizontal integration means buying out competitors in the same industry, the strategy Standard Oil used to dominate refining.',
  },
  {
    term: 'Vertical integration',
    definition:
      'Owning every stage of production, from raw materials to distribution, under one company.',
    question:
      'Carnegie owned the mines, the railcars, and the steel mills alike. What strategy is this?',
    distractors: ['Horizontal integration', 'Monopoly pricing', 'Pool agreement'],
    explanation: 'Controlling every stage cut costs and shut out suppliers and middlemen.',
    topic: 'Big business',
    quote:
      'Vertical integration put every step from raw ore to finished steel under one owner, which is how Carnegie cut costs.',
  },
  {
    term: 'Social Darwinism',
    definition:
      'The belief that success in society reflected natural superiority, used to justify inequality and weak regulation.',
    question: 'Which ideology used "survival of the fittest" to defend the era\'s inequality?',
    distractors: ['The Social Gospel', 'Populism', 'Progressivism'],
    explanation:
      'Reformers pushed back with the Social Gospel, arguing society had a duty to fix poverty.',
    topic: 'Ideas',
    quote:
      'Social Darwinism applied "survival of the fittest" to society, a belief reformers countered with the Social Gospel.',
  },
  {
    term: 'Knights of Labor',
    definition:
      'The inclusive union founded in 1869 that welcomed nearly all workers and sought broad reform; it declined after the Haymarket affair.',
    question:
      'Which union welcomed women, Black workers, and immigrants before collapsing after Haymarket?',
    distractors: [
      'The American Federation of Labor',
      'The Grange',
      'The Industrial Workers of the World',
    ],
    explanation: 'Its broad idealism gave way to the AFL\'s narrower "bread and butter" focus.',
    topic: 'Labor',
    quote:
      'The Knights of Labor accepted nearly all workers, but public blame for the Haymarket bombing destroyed the order.',
  },
  {
    term: 'American Federation of Labor',
    definition:
      'The 1886 federation of craft unions led by Samuel Gompers that focused on wages, hours, and working conditions.',
    question: 'Which federation organized skilled workers around "bread and butter" goals?',
    distractors: ['The Knights of Labor', 'The Populist Party', 'The Grange'],
    explanation:
      "Collective bargaining over concrete demands made it the era's most durable labor group.",
    topic: 'Labor',
    aliases: ['AFL'],
    quote:
      'The American Federation of Labor, founded in 1886, bargained for wages, hours, and safety through skilled craft unions.',
  },
  {
    term: 'Chinese Exclusion Act',
    definition:
      'The 1882 law banning Chinese immigration, the first federal restriction based on nationality.',
    question: 'Which 1882 law was the first to bar immigrants by nationality?',
    distractors: ["The Gentleman's Agreement", 'The Emergency Quota Act', 'The Naturalization Act'],
    explanation: 'Nativist pressure on the West Coast drove it, and it stood until 1943.',
    topic: 'Immigration',
    quote:
      'The Chinese Exclusion Act of 1882 was the first federal law to bar immigrants based on nationality.',
  },
  {
    term: 'Political machine',
    definition:
      'A party organization that traded jobs and services for votes, run by a boss, such as Tammany Hall under Tweed.',
    question: 'What kind of organization exchanged city jobs for immigrant votes?',
    distractors: ['A labor union', 'A reform commission', "A farmers' alliance"],
    explanation:
      'Machines served real needs for new immigrants while draining public money through graft.',
    topic: 'Politics',
    quote:
      'Political machines like Tammany Hall traded jobs and favors for votes, and bosses like Tweed grew rich on graft.',
  },
  {
    term: 'Pendleton Civil Service Act',
    definition:
      'The 1883 law that made many federal jobs depend on merit exams instead of patronage.',
    question: 'Which law created merit-based federal hiring?',
    distractors: [
      'The Interstate Commerce Act',
      'The Sherman Antitrust Act',
      'The Seventeenth Amendment',
    ],
    explanation:
      "Garfield's assassination by a frustrated office-seeker pushed it through Congress.",
    topic: 'Politics',
    quote:
      'After Garfield was assassinated by a frustrated office-seeker, the Pendleton Act of 1883 required merit exams for many federal jobs.',
  },
];

const civilWarDrafts: Draft[] = [
  {
    term: 'Secession',
    definition:
      "The withdrawal of eleven Southern states from the Union after Lincoln's 1860 election.",
    question: 'What did Southern states do after the election of 1860?',
    distractors: ['Impeach Lincoln', 'Boycott Northern goods', 'Declare war on Mexico'],
    explanation:
      'South Carolina seceded first in December 1860, and the Confederacy formed by February.',
    topic: 'Causes of the war',
  },
  {
    term: 'Fort Sumter',
    definition: 'The Charleston harbor fort whose bombardment in April 1861 opened the Civil War.',
    question: 'Where were the first shots of the Civil War fired?',
    distractors: ['Gettysburg', 'Antietam', 'Bull Run'],
    explanation:
      'After the surrender, Lincoln called for volunteers, and four more states seceded.',
    topic: 'The war begins',
  },
  {
    term: 'Anaconda Plan',
    definition:
      'The Union strategy to blockade Southern ports and seize the Mississippi to squeeze the Confederacy.',
    question: "What was the Union's three-part war strategy called?",
    distractors: ['Total war', 'The Peninsula Campaign', 'The Overland Campaign'],
    explanation: 'The slow squeeze looked timid in 1861 but strangled Southern trade by 1863.',
    topic: 'Military strategy',
  },
  {
    term: 'Emancipation Proclamation',
    definition:
      "Lincoln's 1863 order declaring enslaved people free in states in rebellion against the Union.",
    question: 'What did the Emancipation Proclamation do?',
    distractors: [
      'Freed enslaved people in border states',
      'Ended slavery nationwide',
      'Compensated slaveholders',
    ],
    explanation:
      'It reframed the war against slavery and blocked European recognition of the Confederacy.',
    topic: 'The war turns',
    aliases: ['Proclamation of Emancipation'],
  },
  {
    term: 'Thirteenth Amendment',
    definition:
      'The 1865 amendment to the Constitution that abolished slavery in the United States.',
    question: 'Which amendment abolished slavery?',
    distractors: ['Fourteenth Amendment', 'Fifteenth Amendment', 'Nineteenth Amendment'],
    explanation:
      'The Proclamation alone did not cover loyal areas, so the amendment finished the job.',
    topic: 'Reconstruction',
  },
  {
    term: 'Fourteenth Amendment',
    definition:
      'The 1868 amendment defining national citizenship and requiring states to provide equal protection under the law.',
    question: 'Which amendment made everyone born in the US a citizen?',
    distractors: ['Thirteenth Amendment', 'Fifteenth Amendment', 'Sixteenth Amendment'],
    explanation:
      'Its equal protection clause became the legal basis for the civil rights movement a century later.',
    topic: 'Reconstruction',
  },
  {
    term: 'Fifteenth Amendment',
    definition: 'The 1870 amendment barring the denial of voting rights because of race.',
    question: 'Which amendment protected voting rights regardless of race?',
    distractors: ['Fourteenth Amendment', 'Nineteenth Amendment', 'Twenty-fourth Amendment'],
    explanation:
      'It left literacy tests and poll taxes untouched, loopholes Southern states exploited immediately.',
    topic: 'Reconstruction',
  },
  {
    term: "Freedmen's Bureau",
    definition:
      'The federal agency that helped formerly enslaved people with food, schools, and labor contracts after the war.',
    question: 'Which agency built schools and negotiated labor contracts for freed people?',
    distractors: ['The War Department', 'The Homestead Office', 'The Reconstruction Committee'],
    explanation: 'It founded thousands of schools, including several that became HBCUs.',
    topic: 'Reconstruction',
  },
  {
    term: 'Black Codes',
    definition:
      'Southern laws passed after the war that restricted the labor, movement, and rights of freed people.',
    question: 'What were the Southern laws restricting freed people called?',
    distractors: ['Jim Crow laws', 'Redemption laws', 'Navigation acts'],
    explanation:
      'They aimed to rebuild a labor system as close to slavery as possible, pushing Congress toward Radical Reconstruction.',
    topic: 'Reconstruction',
  },
  {
    term: 'Radical Republicans',
    definition:
      'The Republican faction that demanded full citizenship for freed people and firm terms for ex-Confederates.',
    question:
      'Which faction pushed the Civil Rights Act of 1866 and the Reconstruction Amendments?',
    distractors: ['Copperheads', 'Redeemers', 'Scalawags'],
    explanation:
      "Thaddeus Stevens and Charles Sumner led the fight against Johnson's lenient plan.",
    topic: 'Reconstruction',
    aliases: ['Radicals'],
  },
  {
    term: 'Carpetbagger',
    definition:
      'A hostile label for Northerners who moved to the South during Reconstruction, supposedly seeking profit.',
    question: 'What did white Southerners call Northerners who moved south during Reconstruction?',
    distractors: ['Scalawags', 'Redeemers', 'Bonerattlers'],
    explanation: 'Many were teachers, veterans, and businessmen, but the stereotype stuck.',
    topic: 'Reconstruction',
  },
  {
    term: 'Compromise of 1877',
    definition:
      'The informal deal that made Rutherford B. Hayes president in exchange for removing federal troops from the South.',
    question: 'What agreement ended Reconstruction in 1877?',
    distractors: ['The Amnesty Act', 'The Bargain of 1876', 'The Mississippi Plan'],
    explanation:
      'With troops gone, Southern states stripped Black voting rights within a generation.',
    topic: 'End of Reconstruction',
  },
];

const statsDescribeDrafts: Draft[] = [
  {
    term: 'Mean',
    definition: 'The average of a data set: add all the values, then divide by how many there are.',
    question: 'What is the balance point of a data set called?',
    distractors: ['Median', 'Mode', 'Range'],
    explanation:
      'The mean is sensitive to outliers, which is why medians describe skewed income data better.',
    topic: 'Center',
  },
  {
    term: 'Median',
    definition: 'The middle value of an ordered data set, or the average of the two middle values.',
    question: 'What is the middle value of an ordered list of data called?',
    distractors: ['Mean', 'First quartile', 'Midrange'],
    explanation: 'Half the values sit at or below it, so outliers barely move it.',
    topic: 'Center',
  },
  {
    term: 'Interquartile range',
    definition: 'The spread of the middle 50% of a data set, found by Q3 minus Q1.',
    question: 'Which measure of spread ignores the top and bottom 25% of values?',
    distractors: ['Range', 'Standard deviation', 'Variance'],
    explanation: 'Because it resists outliers, the IQR anchors the 1.5×IQR rule and boxplots.',
    topic: 'Spread',
    aliases: ['IQR'],
  },
  {
    term: 'Standard deviation',
    definition: 'A measure of how far values typically fall from the mean.',
    question: 'Which measure describes the typical distance from the mean?',
    distractors: ['IQR', 'Range', 'Mode'],
    explanation: 'It uses the mean in its formula, so outliers inflate it.',
    topic: 'Spread',
  },
  {
    term: 'Outlier',
    definition:
      'A value that stands apart from the rest; by the 1.5×IQR rule, below Q1−1.5·IQR or above Q3+1.5·IQR.',
    question: 'By the 1.5×IQR rule, when is a value an outlier?',
    distractors: [
      'Beyond one standard deviation',
      'Outside the min and max',
      'When it appears more than twice',
    ],
    explanation: 'Outliers matter most for the mean, the standard deviation, and regression fits.',
    topic: 'Spread',
  },
  {
    term: 'Right-skewed distribution',
    definition:
      'A distribution with a long tail of high values, where the mean is greater than the median.',
    question: 'If the mean is greater than the median, what shape does the data likely have?',
    distractors: ['Left-skewed', 'Symmetric', 'Uniform'],
    explanation:
      'Incomes and wait times are classic examples: a few large values stretch the tail right.',
    topic: 'Shape',
    aliases: ['positively skewed'],
  },
  {
    term: 'Histogram',
    definition:
      'A chart that groups values into equal-width intervals and shows counts as adjoining bars.',
    question:
      'Which graph shows the distribution of a quantitative variable with bars over intervals?',
    distractors: ['Bar chart', 'Dotplot', 'Stemplot'],
    explanation:
      'The bars touch because the variable is continuous; separate bars mean categorical data.',
    topic: 'Graphs',
  },
  {
    term: 'Boxplot',
    definition:
      'A graph of the five-number summary (minimum, Q1, median, Q3, maximum) that flags outliers as dots.',
    question: 'Which graph displays the five-number summary?',
    distractors: ['Histogram', 'Cumulative frequency plot', 'Normal curve'],
    explanation:
      'The whiskers stop at the last non-outlier value, and outliers appear as individual points.',
    topic: 'Graphs',
    aliases: ['box-and-whisker plot'],
  },
  {
    term: 'Normal distribution',
    definition:
      'The symmetric, bell-shaped distribution described completely by its mean and standard deviation.',
    question: 'Which distribution is symmetric and bell-shaped?',
    distractors: ['Uniform distribution', 'Exponential distribution', 'Chi-square distribution'],
    explanation: 'The 68-95-99.7 rule only applies here, never to skewed data.',
    topic: 'Normal model',
  },
  {
    term: 'Empirical rule',
    definition:
      'In a normal distribution, about 68%, 95%, and 99.7% of values fall within 1, 2, and 3 standard deviations of the mean.',
    question:
      'What percentage of a normal distribution falls within one standard deviation of the mean?',
    distractors: ['50%', '95%', '99.7%'],
    explanation: 'It doubles as a sanity check for whether data plausibly fits a normal model.',
    topic: 'Normal model',
    aliases: ['68-95-99.7 rule'],
  },
  {
    term: 'Z-score',
    definition: 'The number of standard deviations a value sits above or below the mean.',
    question: 'How do you compare values measured on different scales?',
    distractors: ['By their ranks', 'By their percentiles', 'By subtracting the means'],
    explanation:
      'Converting to z-scores puts everything on one scale and unlocks normal-model probabilities.',
    topic: 'Normal model',
    aliases: ['standard score'],
  },
  {
    term: 'Residual',
    definition:
      'The difference between an observed value and the value a regression model predicts.',
    question: 'What do you call the error left over after a prediction?',
    distractors: ['Deviation', 'Coefficient', 'Correlation'],
    explanation: 'A random scatter of residuals around zero means the linear model fits well.',
    topic: 'Regression',
    aliases: ['prediction error'],
  },
];

const statsDesignDrafts: Draft[] = [
  {
    term: 'Population',
    definition: 'The entire group of individuals or cases about which we want information.',
    question:
      'In a study of all US high schoolers, what is the whole group we want to describe called?',
    distractors: ['Sample', 'Census', 'Sampling frame'],
    explanation:
      'Every statistical conclusion is really about the population, not the sample itself.',
    topic: 'Sampling',
    quote:
      'Inference travels from the sample back to the population, the whole group we actually want to describe.',
  },
  {
    term: 'Sample',
    definition: 'The part of the population from which we actually collect data.',
    question: 'What do we call the group we actually gather data from?',
    distractors: ['Population', 'Frame', 'Block'],
    explanation: 'A good sample represents the population, not just whoever was easy to reach.',
    topic: 'Sampling',
    quote:
      'The sample is the subset we collect data from, and only a representative sample can speak for the population.',
  },
  {
    term: 'Census',
    definition: 'Data collected from every member of the population.',
    question: 'What do you call a count of the entire population?',
    distractors: ['Sample survey', 'Stratified sample', 'Systematic sample'],
    explanation: 'Even a census misses people, which is why sampling design still matters.',
    topic: 'Sampling',
    quote: 'A census tries to reach every member of the population, leaving no one out.',
  },
  {
    term: 'Convenience sample',
    definition:
      'A sampling method that chooses whoever is easiest to reach, producing strong bias.',
    question: 'Interviewing only people at the mall is an example of what kind of sample?',
    distractors: ['Simple random sample', 'Stratified sample', 'Cluster sample'],
    explanation: "It overrepresents whoever shares the recruiter's location, hours, and habits.",
    topic: 'Bias',
    quote:
      'A convenience sample takes whoever is easiest to reach, which is why mall interviews lean toward certain people.',
  },
  {
    term: 'Simple random sample',
    definition:
      'A sample in which every possible group of members has an equal chance of being selected.',
    question: 'Which sampling method gives every group of members an equal chance of selection?',
    distractors: ['Convenience sample', 'Systematic sample', 'Voluntary response sample'],
    explanation: 'A lottery-style draw or random number generator both qualify.',
    topic: 'Sampling methods',
    aliases: ['SRS'],
    quote: 'In a simple random sample, every group of members has an equal chance of being chosen.',
  },
  {
    term: 'Stratified random sample',
    definition:
      'A sample that splits the population into similar strata and takes a separate simple random sample from each.',
    question: 'Sampling separately from each grade, then combining, is which method?',
    distractors: ['Cluster sample', 'Simple random sample', 'Systematic sample'],
    explanation:
      'Strata hold similar individuals, so sampling within each guarantees representation.',
    topic: 'Sampling methods',
    quote:
      'Stratified sampling divides similar individuals into strata and takes an SRS from each one.',
  },
  {
    term: 'Observational study',
    definition: 'A study that measures outcomes without imposing any treatment on the subjects.',
    question:
      'Researchers measured sleep and grades without assigning anything. What kind of study is this?',
    distractors: ['Experiment', 'Matched pairs design', 'Placebo trial'],
    explanation: 'No treatment means you can describe association but never prove cause.',
    topic: 'Study types',
    quote:
      'An observational study watches and measures without imposing a treatment, so it shows association, not cause.',
  },
  {
    term: 'Experiment',
    definition:
      'A study in which researchers assign treatments to subjects and observe how responses change.',
    question: 'What kind of study can establish cause and effect?',
    distractors: ['Observational study', 'Sample survey', 'Census'],
    explanation:
      'Random assignment balances confounders across treatment groups, which makes causation credible.',
    topic: 'Study types',
    quote: 'Only an experiment, where treatment is assigned by chance, can show cause and effect.',
  },
  {
    term: 'Confounding variable',
    definition:
      "A variable whose effect mixes with the treatment's effect, making the true cause unclear.",
    question:
      'Coffee drinkers smoke more, and smoking causes illness. What kind of variable is smoking here?',
    distractors: ['Response variable', 'Control variable', 'Blocking variable'],
    explanation: 'Confounding is why observational studies about coffee keep flip-flopping.',
    topic: 'Bias',
    aliases: ['lurking variable'],
    quote:
      "A confounding variable mixes its effect with the treatment's effect, so the observed link has an unclear cause.",
  },
  {
    term: 'Placebo effect',
    definition:
      "The response caused by a subject's expectations rather than by the treatment itself.",
    question: 'Why does an honest experiment include a group that receives a fake treatment?',
    distractors: [
      'To increase the sample size',
      'To make randomization possible',
      'To reduce cost',
    ],
    explanation:
      "Only a comparison against a placebo separates the drug's effect from the expectation effect.",
    topic: 'Design',
    quote:
      'A placebo controls for the effect of expectation, so only the treatment itself differs between groups.',
  },
  {
    term: 'Blocking',
    definition:
      'Grouping experimental units that are similar, then randomizing treatments separately within each group.',
    question: 'In a drug trial, why randomize men and women within their own groups?',
    distractors: [
      'To increase the sample size',
      'To double the treatments',
      'To remove the need for a placebo',
    ],
    explanation:
      'Blocks absorb a known source of variation, leaving a cleaner treatment comparison.',
    topic: 'Design',
    aliases: ['randomized block design'],
    quote:
      'Blocking groups similar units together, and randomization happens separately within each block.',
  },
  {
    term: 'Statistical significance',
    definition:
      'A result unlikely to have occurred by chance alone under the stated significance level.',
    question: 'A result with p = 0.03 against a 0.05 cutoff is called what?',
    distractors: ['Proven true', 'Practically important', 'Randomly assigned'],
    explanation:
      'Significance speaks to chance, not importance; a tiny effect in a huge sample can still qualify.',
    topic: 'Inference',
    aliases: ['p-value'],
    quote: 'A statistically significant result is one that would rarely happen by chance alone.',
  },
];

const bioLectureText = `AP Biology — Unit 2 lecture notes: Cell structure

Every eukaryotic cell is a factory with specialized compartments. The nucleus stores DNA in the form of chromatin and acts as the cell's control center, directing growth and reproduction. The nuclear envelope keeps transcription separate from the cytoplasm, and messenger RNA leaves through nuclear pores.

Ribosomes read messenger RNA and link amino acids into proteins, floating free or attached to the rough ER. The rough ER folds and modifies those proteins for membranes or secretion. The smooth ER builds lipids and detoxifies compounds, and it stores calcium ions for muscle cells.

The Golgi apparatus tags and packages proteins into vesicles for delivery, like the cell's shipping department. Lysosomes digest worn-out organelles and large molecules using enzymes that work in an acidic interior. Peroxisomes break down fatty acids, and catalase converts toxic hydrogen peroxide into water and oxygen.

Mitochondria convert energy from glucose into ATP during cellular respiration, using folded cristae to fit more reaction space. Chloroplasts capture light energy and build sugars, with chlorophyll held in stacked thylakoid membranes called grana.

Plant cells add two structures. The central vacuole stores water, and turgor pressure from a full vacuole keeps plant cells firm. Plant cell walls are rigid layers of cellulose that support the cell and hold its shape.

The plasma membrane is a selectively permeable bilayer, so small nonpolar molecules pass freely but ions need transport proteins. The cytoskeleton is a network of microtubules and microfilaments that anchors organelles and moves vesicles.

Prokaryotes keep it simple: prokaryotic DNA concentrates in the nucleoid, a region of the cytoplasm not enclosed by any membrane. Exam tip: on any prokaryote vs. eukaryote diagram, start with the nuclear envelope.`;

const gildedAgeText = `AP US History — lecture notes: The Gilded Age

Mark Twain called the era "gilded" because a thin layer of gold covered deep social problems beneath the boom. Railroads, oil, and steel built vast fortunes while workers and immigrants crowded into tenements.

The transcontinental railroad was finished in 1869 at Promontory Summit, built largely by Chinese and Irish laborers. Under the Homestead Act of 1862, settlers who farmed 160 acres for five years could claim title to the land, pulling families west.

Critics called men like Rockefeller and Carnegie "robber barons" for building fortunes on ruthless tactics. Horizontal integration means buying out competitors in the same industry, the strategy Standard Oil used to dominate refining. Vertical integration put every step from raw ore to finished steel under one owner, which is how Carnegie cut costs.

Social Darwinism applied "survival of the fittest" to society, a belief reformers countered with the Social Gospel.

Workers organized. The Knights of Labor accepted nearly all workers, but public blame for the Haymarket bombing destroyed the order. The American Federation of Labor, founded in 1886, bargained for wages, hours, and safety through collective bargaining by skilled craft unions.

Nativism hardened into law: the Chinese Exclusion Act of 1882 was the first federal law to bar immigrants based on nationality. In cities, political machines like Tammany Hall traded jobs and favors for votes, and bosses like Tweed grew rich on graft. After Garfield was assassinated by a frustrated office-seeker, the Pendleton Act of 1883 required merit exams for many federal jobs.`;

const statsDesignText = `AP Statistics — lecture notes: study design

Statistics is about collecting good data, not just crunching it. Inference travels from the sample back to the population, the whole group we actually want to describe. The sample is the subset we collect data from, and a census tries to reach every member of the population.

Bad samples are worse than no samples. A convenience sample takes whoever is easiest to reach, which is why mall interviews lean toward certain people. Voluntary response samples attract people with strong opinions. In a simple random sample, by contrast, every group of members has an equal chance of being chosen. Stratified sampling divides similar individuals into strata and takes an SRS from each one, which guarantees every stratum is represented.

An observational study watches and measures without imposing a treatment, so it shows association but not cause. Only an experiment, where treatment is assigned by chance, can show cause and effect, because random assignment balances confounders between groups.

Watch for a confounding variable, one whose effect mixes with the treatment's effect so the observed link has an unclear cause. A placebo controls for the effect of expectation, so only the treatment itself differs between groups. Blocking groups similar units together and randomizes separately within each block. Finally, a statistically significant result is one that would rarely happen by chance alone; significance speaks to chance, never to practical importance.`;

function makeSource(courseId: string, name: string, kind: string, text: string): Source {
  const sid = randomUUID();
  const base = path.join(uploadDir, sid);
  fs.writeFileSync(base, Buffer.from(name, 'latin1'));
  fs.writeFileSync(base + '.txt', text);
  const src: Source = {
    id: sid,
    courseId,
    name,
    size: Buffer.byteLength(text),
    kind,
    textPath: base + '.txt',
    path: base,
    status: 'ready',
    error: null,
    createdAt: ts(21),
  };
  put('sources', src);
  return src;
}

function makeCourse(
  name: string,
  code: string,
  color: string,
  description: string,
  daysAgo: number,
): Course {
  const c: Course = {
    id: randomUUID(),
    name,
    code,
    color,
    description,
    createdAt: ts(daysAgo),
    archived: false,
  };
  put('courses', c);
  return c;
}

const bio = makeCourse(
  'AP Biology',
  'BIO 240',
  'green',
  'Cells, genetics, and the systems that keep organisms running.',
  20,
);
const apush = makeCourse(
  'AP US History',
  'HIST 110',
  'orange',
  'From Reconstruction to the modern era, with sources to back every claim.',
  19,
);
const stats = makeCourse(
  'AP Statistics',
  'STAT 150',
  'blue',
  'Distributions, design, and inference. Learn to see through bad data.',
  18,
);

const uploadDir = path.join(DATA, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });

function makeSet(
  course: Course,
  title: string,
  description: string,
  origin: 'lecture' | 'manual',
  daysAgo: number,
  drafts: Draft[],
  sources: Source[] = [],
): { set: StudySet; cards: Card[] } {
  const setId = randomUUID();
  const set: StudySet = {
    id: setId,
    courseId: course.id,
    title,
    description,
    createdAt: ts(daysAgo),
    updatedAt: ts(daysAgo),
    archived: false,
    origin,
    warnings: [],
  };
  put('sets', set);
  const cards: Card[] = drafts.map((d, i) => {
    const card: Card = {
      id: randomUUID(),
      setId,
      term: d.term,
      definition: d.definition,
      question: d.question || '',
      distractors: d.distractors || [],
      explanation: d.explanation || '',
      topic: d.topic || 'General',
      sources:
        sources.length && d.quote
          ? [{ sourceId: sources[0].id, locator: 'Lecture notes', quote: d.quote }]
          : [],
      starred: false,
      version: 1,
      position: i,
      aliases: d.aliases || [],
      image: null,
    };
    put('cards', card);
    return card;
  });
  return { set, cards };
}

const bioCell = makeSet(
  bio,
  'Cell Structure and Function',
  'Organelles, membranes, and what prokaryotes lack. Built from the Unit 2 lecture notes.',
  'lecture',
  19,
  bioCellDrafts,
  [makeSource(bio.id, 'Unit 2 lecture notes - cell structure.txt', 'TXT', bioLectureText)],
);
const bioGenetics = makeSet(
  bio,
  'Genetics and Heredity',
  "Mendel's laws and what happens when inheritance refuses to follow the textbook.",
  'manual',
  12,
  bioGeneticsDrafts,
);
const gildedAge = makeSet(
  apush,
  'The Gilded Age',
  'Industry, immigration, and the gap between the glitter and the graft, 1870-1900.',
  'lecture',
  17,
  gildedAgeDrafts,
  [makeSource(apush.id, 'Gilded Age lecture notes.txt', 'TXT', gildedAgeText)],
);
const civilWar = makeSet(
  apush,
  'Civil War and Reconstruction',
  'From Fort Sumter to the deal that ended Reconstruction, with the amendments in between.',
  'manual',
  9,
  civilWarDrafts,
);
const statsDescribe = makeSet(
  stats,
  'Describing Data and Distributions',
  'Centers, spreads, shapes, and the graphs that tell the truth about a data set.',
  'manual',
  10,
  statsDescribeDrafts,
);
const statsDesign = makeSet(
  stats,
  'Study Design and Inference',
  'Samples, experiments, and the difference between association and cause.',
  'lecture',
  3,
  statsDesignDrafts,
  [makeSource(stats.id, 'Study design lecture notes.txt', 'TXT', statsDesignText)],
);

const allSetsList: { set: StudySet; cards: Card[] }[] = [
  bioCell,
  bioGenetics,
  gildedAge,
  civilWar,
  statsDescribe,
  statsDesign,
];
const cards: Card[] = [
  bioCell.cards,
  bioGenetics.cards,
  gildedAge.cards,
  civilWar.cards,
  statsDescribe.cards,
  statsDesign.cards,
].flat();

const starTerms = [
  'Mitochondrion',
  'Law of segregation',
  'Emancipation Proclamation',
  'Fourteenth Amendment',
  'Empirical rule',
  'Statistical significance',
  'Plasma membrane',
  'Chinese Exclusion Act',
];
for (const card of cards)
  if (starTerms.includes(card.term)) put('cards', { ...card, starred: true });

const progress = new Map<string, CardProgress>();
let attemptsCount = 0;
let sessionCounter = 0;
const stubborn = new Set(cards.filter((_, i) => i % 11 === 3).map((c) => c.id));
const firstSeen = new Set<string>();

function record(
  card: Card,
  session: any,
  kind: Attempt['kind'],
  response: string,
  correct: boolean | null,
  durationMs: number,
  when: string,
  matchedCardId?: string,
) {
  const a: Attempt = {
    id: randomUUID(),
    sessionId: session.id,
    cardId: card.id,
    setId: session.setId,
    courseId: session.courseId,
    mode: session.mode,
    kind,
    response,
    correct,
    durationMs,
    createdAt: when,
    cardVersion: card.version,
  };
  put('attempts', {
    ...a,
    cardSnapshot: { term: card.term, definition: card.definition },
    ...(matchedCardId ? { matchedCardId } : {}),
  });
  attemptsCount++;
  const next = advance(progress.get(card.id), a);
  put('progress', { ...next, id: card.id });
  progress.set(card.id, next);
}

function makeSession(set: StudySet, mode: string, when: string, setCards: Card[]) {
  sessionCounter++;
  let chosen = setCards;
  if (mode === 'match') {
    const defs = new Set<string>();
    chosen = chosen.filter((c) => {
      const k = c.definition.trim().toLowerCase();
      if (defs.has(k)) return false;
      defs.add(k);
      return true;
    });
    chosen = chosen.slice(0, 6);
  }
  const session = {
    id: randomUUID(),
    bestTime: mode === 'match' ? 14380 + Math.floor(rand() * 40) * 210 : null,
    setId: set.id,
    courseId: set.courseId,
    mode,
    settings: {
      setId: set.id,
      mode,
      shuffle: true,
      sorting: true,
      audio: false,
      starred: false,
      direction: 'term',
    },
    createdAt: when,
    updatedAt: when,
    completedAt: when,
    cards: chosen,
    state: { index: chosen.length, answers: {}, queue: [] },
  };
  put('sessions', session);
  return session;
}

const dayOffsets = [18, 17, 16, 14, 12, 11, 10, 8, 7, 6, 5, 4, 3, 2, 1, 0];

for (const offset of dayOffsets) {
  const eligible = allSetsList.filter(
    (s) => Date.parse(s.set.createdAt) <= Date.parse(ts(offset, 0)),
  );
  const count = eligible.length <= 3 ? eligible.length : 2 + (chance(0.5) ? 1 : 0);
  const shuffledSets = [...eligible].sort(() => rand() - 0.5);
  const today = shuffledSets.slice(0, count);

  today.forEach((entry, k) => {
    const { set, cards: setCards } = entry;
    const sessionStart = ts(offset, 12 + k * 14);
    const studied = firstSeen.has(set.id);
    if (!studied) {
      const s = makeSession(set, 'flashcards', sessionStart, setCards);
      setCards.forEach((card, i) => {
        const t = ts(offset, 12 + k * 14 + i * 2.2);
        record(card, s, 'view', '', null, 3000 + Math.floor(rand() * 7000), t);
        if (chance(0.85))
          record(card, s, 'self', 'Got it', true, 8000 + Math.floor(rand() * 6000), t);
        else record(card, s, 'self', 'Still learning', false, 9000 + Math.floor(rand() * 8000), t);
      });
      firstSeen.add(set.id);
      return;
    }
    const roll = rand();
    if (roll < 0.55) {
      const s = makeSession(set, 'learn', sessionStart, setCards);
      setCards.forEach((card, i) => {
        const known = progress.get(card.id);
        const correct = !chance(stubborn.has(card.id) ? 0.3 : 0.1);
        const kind = known && known.objectiveAttempts >= 2 && known.lastCorrect ? 'written' : 'mcq';
        let response: string;
        if (kind === 'mcq') {
          response = correct
            ? card.definition
            : pick([
                ...card.distractors,
                ...setCards
                  .filter((c) => c.id !== card.id)
                  .slice(0, 2)
                  .map((c) => c.definition),
              ]);
        } else {
          response = correct
            ? card.definition
            : pick(setCards.filter((c) => c.id !== card.id)).definition;
        }
        const dur =
          kind === 'mcq' ? 6000 + Math.floor(rand() * 14000) : 12000 + Math.floor(rand() * 30000);
        record(card, s, kind, response, correct, dur, ts(offset, 12 + k * 14 + i * 1.6 + 1));
      });
    } else if (roll < 0.78) {
      const s = makeSession(set, 'match', sessionStart, setCards);
      s.cards.forEach((card, i) => {
        const correct = !chance(0.12);
        record(
          card,
          s,
          'match',
          '',
          correct,
          2200 + Math.floor(rand() * 5200),
          ts(offset, 12 + k * 14 + i * 0.25 + 1),
          correct ? card.id : pick(s.cards.filter((c) => c.id !== card.id)).id,
        );
      });
    } else {
      const s = makeSession(set, 'learn', sessionStart, setCards);
      setCards.forEach((card, i) => {
        const correct = !chance(stubborn.has(card.id) ? 0.28 : 0.12);
        const response = correct
          ? card.definition
          : pick(setCards.filter((c) => c.id !== card.id)).definition;
        record(
          card,
          s,
          'written',
          response,
          correct,
          14000 + Math.floor(rand() * 26000),
          ts(offset, 12 + k * 14 + i * 1.6 + 1),
        );
      });
    }
  });
}

const apushId = apush.id;
const gildedSet = gildedAge.set;
const civilSet = civilWar.set;

// a couple of fresh conversations for the insights page
function conv(
  title: string,
  courseId: string | null,
  msgs: {
    role: 'user' | 'assistant';
    content: string;
    actions?: any[];
    evidence?: string[];
    daysAgo: number;
  }[],
) {
  const cid = randomUUID();
  put('conversations', {
    id: cid,
    courseId,
    title,
    createdAt: ts(Math.max(...msgs.map((m) => m.daysAgo)), 120),
  });
  msgs.forEach((m) => {
    put('messages', {
      id: randomUUID(),
      conversationId: cid,
      role: m.role,
      content: m.content,
      createdAt: ts(m.daysAgo, 60),
      actions: m.actions || [],
      evidence: m.evidence || [],
      jobId: null,
    });
  });
}

conv('What should I focus on next?', null, [
  { role: 'user', content: 'What should I focus on next?', daysAgo: 1 },
  {
    role: 'assistant',
    content: `You're carrying a **9-day streak** and overall accuracy is holding at **89%**, so the habit itself is working. Here's where attention would pay off most:

1. **AP US History - Reconstruction amendments.** You've missed the Fifteenth Amendment twice in written practice, and it keeps getting mixed up with the Fourteenth. That pairing is worth 15 minutes.
2. **AP Statistics - sampling methods.** Stratified versus cluster is your most-missed distinction this week (3 misses). The tell: strata are groups *you split*, clusters are groups *you sample whole*.
3. **Biology is in good shape.** Cell Structure sits at 92% with five retained cards. Keep it in the daily rotation, no extra time needed.

The Civil War set is the weakest overall: most of its cards are still in learning status.`,
    actions: [
      {
        label: 'Practice Civil War and Reconstruction',
        path: `/sets/${civilSet.id}/learn`,
        reason: 'Most cards still in learning status',
      },
      {
        label: 'Review The Gilded Age',
        path: `/sets/${gildedSet.id}/learn`,
        reason: 'Four terms are due for review today',
      },
    ],
    evidence: [
      'Snapshot: 356 objective attempts, 89% accuracy, 9-day streak across 3 courses.',
      'Card ranking: Fifteenth Amendment - 2 incorrect written attempts in the last 7 days.',
      'Stratified random sample: 3 incorrect attempts across match and learn modes.',
    ],
    daysAgo: 1,
  },
  { role: 'user', content: 'How is my progress across my courses?', daysAgo: 2 },
  {
    role: 'assistant',
    content: `Here's the cross-course picture, ranked by how much each course needs you:

| Course | Accuracy | Retained | Still learning |
| --- | --- | --- | --- |
| AP US History | 81% | 4 | 9 |
| AP Statistics | 89% | 6 | 3 |
| AP Biology | 92% | 8 | 2 |

AP US History is the outlier. The content is newer, since you added *Civil War and Reconstruction* last week, so lower retention is expected rather than a problem. Short daily sessions will close the gap.`,
    actions: [
      {
        label: 'Open AP US History',
        path: `/courses/${apushId}`,
        reason: 'Lowest accuracy of your three courses',
      },
    ],
    evidence: [
      'Per-course aggregates from the progress snapshot: Biology 92% (n=118), US History 81% (n=126), Statistics 89% (n=142).',
    ],
    daysAgo: 2,
  },
]);

conv('Help me plan a 20-minute session', apushId, [
  { role: 'user', content: 'Help me plan a 20-minute study session.', daysAgo: 4 },
  {
    role: 'assistant',
    content: `Plan for tonight, built around what's due:

- **5 min** - Warm up with the four Gilded Age terms that are due today.
- **10 min** - Learn round on *Civil War and Reconstruction*, focused on the amendments (your most-missed cards live here).
- **5 min** - One Match game on The Gilded Age to practice recall under time pressure.

That covers every due card and touches two modes. If you have energy left, finish with a written round on the amendments.`,
    actions: [
      {
        label: 'Start the Learn round',
        path: `/sets/${civilSet.id}/learn`,
        reason: 'Covers your most-missed cards',
      },
      {
        label: 'Play a Match game',
        path: `/sets/${gildedSet.id}/match`,
        reason: 'Quick recall warm-down',
      },
    ],
    evidence: [
      'Snapshot: 9 cards due for review across 2 courses; 4 of them are in The Gilded Age.',
      'Ranked cards: the Reconstruction amendments hold 3 of the 5 weakest cards.',
    ],
    daysAgo: 4,
  },
]);

put('settings', { id: 'name', value: 'Maya' });

console.log('Seeded:', {
  courses: 3,
  sets: allSetsList.length,
  cards: cards.length,
  attempts: attemptsCount,
  sessions: sessionCounter,
  conversations: 2,
});
