import Anthropic from '@anthropic-ai/sdk';
import type { Listing, Feedback, GradeRow } from './db.js';
import { insertGrade, logEvent } from './db.js';

const anthropic = new Anthropic();

const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';

export interface GradeResult {
  score: number;
  grade: string;
  rationale: string;
  flags: string[];
}

export interface GradeStats {
  graded: number;
  failed: number;
  averageScore: number;
}

export function buildPrompt(
  criteria: string,
  listing: Listing,
  disagreements: Feedback[],
  agreements: Feedback[]
): string {
  let prompt = `You are an expert automotive parts grader. Grade the following listing based on these criteria:\n\n`;
  prompt += `${criteria}\n\n`;

  // Past disagreements for learning
  if (disagreements.length > 0) {
    prompt += `--- LEARN FROM THESE PAST DISAGREEMENTS ---\n`;
    prompt += `These are cases where the buyer disagreed with the AI's grade. Adjust your grading to align with the buyer's expectations.\n\n`;

    for (const d of disagreements) {
      prompt += `- "${d.listing_title}": AI scored ${d.score} (${d.grade}), buyer adjusted to ${d.adjusted_score ?? 'N/A'}`;
      if (d.notes) {
        prompt += ` — Notes: "${d.notes}"`;
      }
      prompt += `\n`;
    }
    prompt += `\n`;
  }

  // Well-graded examples
  if (agreements.length > 0) {
    prompt += `--- EXAMPLES OF WELL-GRADED LISTINGS ---\n`;
    prompt += `These are cases where the buyer agreed with the AI's grade.\n\n`;

    for (const a of agreements) {
      prompt += `- "${a.listing_title}": Score ${a.score} (${a.grade})\n`;
    }
    prompt += `\n`;
  }

  // Listing to grade
  prompt += `--- LISTING TO GRADE ---\n`;
  prompt += `Title: ${listing.title}\n`;
  prompt += `Price: ${listing.price ?? 'N/A'}\n`;
  prompt += `Condition: ${listing.condition ?? 'N/A'}\n`;
  prompt += `Location: ${listing.location ?? 'N/A'}\n`;
  prompt += `Seller: ${listing.seller_name ?? 'N/A'}\n`;
  prompt += `Description: ${listing.description ?? 'N/A'}\n`;
  prompt += `Image: ${listing.image ? 'Yes (1)' : 'No'}\n`;
  prompt += `URL: ${listing.link ?? 'N/A'}\n`;
  prompt += `Source: ${listing.source}\n\n`;

  prompt += `Respond with ONLY a JSON object (no markdown, no code fences) in this exact format:\n`;
  prompt += `{\n`;
  prompt += `  "score": <number 0-100>,\n`;
  prompt += `  "grade": "<A|B|C|D|F>",\n`;
  prompt += `  "rationale": "<1-2 sentence explanation>",\n`;
  prompt += `  "flags": [<array of string flags like "price_high", "no_image", "vague_title", etc.>]\n`;
  prompt += `}\n`;

  return prompt;
}

export async function gradeListing(
  listing: Listing,
  prompt: string,
  dryRun: boolean
): Promise<GradeResult> {
  if (dryRun) {
    return {
      score: 50,
      grade: 'C',
      rationale: 'DRY RUN',
      flags: [],
    };
  }

  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const textBlock = message.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  const raw = textBlock.text.trim();

  // Try to extract JSON even if wrapped in code fences
  let jsonStr = raw;
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  const parsed = JSON.parse(jsonStr) as GradeResult;

  // Validate
  if (
    typeof parsed.score !== 'number' ||
    typeof parsed.grade !== 'string' ||
    typeof parsed.rationale !== 'string'
  ) {
    throw new Error(`Invalid grade response structure: ${raw}`);
  }

  return {
    score: parsed.score,
    grade: parsed.grade,
    rationale: parsed.rationale,
    flags: Array.isArray(parsed.flags) ? parsed.flags : [],
  };
}

export async function gradeInBatches(
  listings: Listing[],
  criteria: string,
  disagreements: Feedback[],
  agreements: Feedback[],
  opts: {
    batchSize: number;
    concurrency: number;
    dryRun: boolean;
    runId: string;
    promptVersion: string;
  }
): Promise<GradeStats> {
  let graded = 0;
  let failed = 0;
  let totalScore = 0;

  for (let i = 0; i < listings.length; i += opts.batchSize) {
    const batch = listings.slice(i, i + opts.batchSize);
    const batchNum = Math.floor(i / opts.batchSize) + 1;
    const totalBatches = Math.ceil(listings.length / opts.batchSize);
    console.log(
      `[${ts()}] Grading batch ${batchNum}/${totalBatches} (${batch.length} listings)`
    );

    // Process with concurrency pool
    for (let j = 0; j < batch.length; j += opts.concurrency) {
      const chunk = batch.slice(j, j + opts.concurrency);

      const results = await Promise.allSettled(
        chunk.map(async (listing) => {
          await logEvent(opts.runId, 'grade_started', listing.id, {
            title: listing.title,
          });

          const prompt = buildPrompt(
            criteria,
            listing,
            disagreements,
            agreements
          );

          const result = await gradeListing(listing, prompt, opts.dryRun);

          const gradeRow: GradeRow = {
            listing_id: listing.id,
            prompt_version: opts.promptVersion,
            score: result.score,
            grade: result.grade,
            rationale: result.rationale,
            flags: result.flags,
            model: opts.dryRun ? 'dry-run' : CLAUDE_MODEL,
          };

          await insertGrade(gradeRow);

          await logEvent(opts.runId, 'grade_completed', listing.id, {
            score: result.score,
            grade: result.grade,
          });

          return result;
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled') {
          graded++;
          totalScore += r.value.score;
        } else {
          failed++;
          console.error(`[${ts()}] Grade failed:`, r.reason);
          // Log failure but don't throw
          await logEvent(opts.runId, 'grade_failed', null, {
            error: String(r.reason),
          });
        }
      }
    }
  }

  return {
    graded,
    failed,
    averageScore: graded > 0 ? Math.round(totalScore / graded) : 0,
  };
}

function ts(): string {
  return new Date().toISOString();
}
