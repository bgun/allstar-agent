import { ChatAnthropic } from '@langchain/anthropic';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import type { Listing, Feedback, GradeRow } from './db.js';
import { insertGrade, logEvent } from './db.js';

const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';

export const gradeResultSchema = z.object({
  score: z.number().min(0).max(100),
  grade: z.enum(['A', 'B', 'C', 'D', 'F']),
  rationale: z.string(),
  flags: z.array(z.string()),
});

const chatModel = new ChatAnthropic({
  model: CLAUDE_MODEL,
  maxTokens: 512,
});

const prompt = ChatPromptTemplate.fromMessages([
  ['system', '{systemPrompt}'],
  ['human', '{userMessage}'],
]);

const gradingChain = prompt.pipe(chatModel.withStructuredOutput(gradeResultSchema));

export function createGradingChain() {
  return gradingChain;
}

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

// --- Prompt caching: split into system (cached) + user (per-listing) ---

export function buildSystemPrompt(
  criteria: string,
  disagreements: Feedback[],
  agreements: Feedback[]
): string {
  let prompt = `You are an expert automotive parts grader. Grade listings based on these criteria:\n\n`;
  prompt += `${criteria}\n\n`;

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

  if (agreements.length > 0) {
    prompt += `--- EXAMPLES OF WELL-GRADED LISTINGS ---\n`;
    prompt += `These are cases where the buyer agreed with the AI's grade.\n\n`;

    for (const a of agreements) {
      prompt += `- "${a.listing_title}": Score ${a.score} (${a.grade})\n`;
    }
    prompt += `\n`;
  }

  prompt += `Respond with ONLY a JSON object (no markdown, no code fences) in this exact format:\n`;
  prompt += `{\n`;
  prompt += `  "score": <number 0-100>,\n`;
  prompt += `  "grade": "<A|B|C|D|F>",\n`;
  prompt += `  "rationale": "<1-2 sentence explanation>",\n`;
  prompt += `  "flags": [<array of string flags like "price_high", "no_image", "vague_title", etc.>]\n`;
  prompt += `}\n`;

  return prompt;
}

export function buildUserMessage(listing: Listing): string {
  let msg = `--- LISTING TO GRADE ---\n`;
  msg += `Title: ${listing.title}\n`;
  msg += `Price: ${listing.price ?? 'N/A'}\n`;
  msg += `Condition: ${listing.condition ?? 'N/A'}\n`;
  msg += `Location: ${listing.location ?? 'N/A'}\n`;
  msg += `Seller: ${listing.seller_name ?? 'N/A'}\n`;
  msg += `Description: ${listing.description ?? 'N/A'}\n`;
  msg += `Image: ${listing.image ? 'Yes (1)' : 'No'}\n`;
  msg += `URL: ${listing.link ?? 'N/A'}\n`;
  msg += `Source: ${listing.source}\n`;
  return msg;
}

export async function gradeListing(
  listing: Listing,
  systemPrompt: string,
  dryRun: boolean,
  metadata?: { runId?: string }
): Promise<GradeResult> {
  if (dryRun) {
    return {
      score: 50,
      grade: 'C',
      rationale: 'DRY RUN',
      flags: [],
    };
  }

  const result = await gradingChain.invoke(
    {
      systemPrompt,
      userMessage: buildUserMessage(listing),
    },
    {
      metadata: {
        run_id: metadata?.runId,
        listing_id: listing.id,
        listing_title: listing.title,
      },
    }
  );

  return {
    score: result.score,
    grade: result.grade,
    rationale: result.rationale,
    flags: result.flags,
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
    abortSignal?: AbortSignal;
  }
): Promise<GradeStats> {
  let graded = 0;
  let failed = 0;
  let totalScore = 0;

  // Build the system prompt once — it gets cached by Anthropic for ~5 min
  const systemPrompt = buildSystemPrompt(criteria, disagreements, agreements);

  for (let i = 0; i < listings.length; i += opts.batchSize) {
    if (opts.abortSignal?.aborted) {
      console.log(`[${ts()}] Run stopped by user — graded ${graded} so far`);
      break;
    }

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

          const result = await gradeListing(listing, systemPrompt, opts.dryRun, {
            runId: opts.runId,
          });

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
