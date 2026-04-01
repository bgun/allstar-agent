import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserMessage, createGradingChain, gradeResultSchema } from './grader.js';
import type { Feedback } from './db.js';

describe('gradeResultSchema', () => {
  it('parses a valid grade result', () => {
    const input = {
      score: 85,
      grade: 'A',
      rationale: 'Great condition headlight with clear lens.',
      flags: ['price_high'],
    };
    const result = gradeResultSchema.parse(input);
    expect(result).toEqual(input);
  });

  it('rejects score out of range', () => {
    expect(() =>
      gradeResultSchema.parse({
        score: 150,
        grade: 'A',
        rationale: 'test',
        flags: [],
      })
    ).toThrow();
  });

  it('rejects invalid grade letter', () => {
    expect(() =>
      gradeResultSchema.parse({
        score: 50,
        grade: 'X',
        rationale: 'test',
        flags: [],
      })
    ).toThrow();
  });
});

describe('buildSystemPrompt', () => {
  it('includes criteria in prompt', () => {
    const prompt = buildSystemPrompt('Grade headlights 1-100', [], []);
    expect(prompt).toContain('Grade headlights 1-100');
    expect(prompt).toContain('expert automotive parts grader');
  });

  it('includes disagreements when provided', () => {
    const disagreements: Feedback[] = [
      {
        listing_title: 'Bad Headlight',
        score: 90,
        grade: 'A',
        adjusted_score: 40,
        notes: 'Cracked lens',
      },
    ];
    const prompt = buildSystemPrompt('criteria', disagreements, []);
    expect(prompt).toContain('PAST DISAGREEMENTS');
    expect(prompt).toContain('Bad Headlight');
    expect(prompt).toContain('Cracked lens');
  });

  it('includes agreements when provided', () => {
    const agreements: Feedback[] = [
      { listing_title: 'Good Headlight', score: 85, grade: 'A' },
    ];
    const prompt = buildSystemPrompt('criteria', [], agreements);
    expect(prompt).toContain('WELL-GRADED LISTINGS');
    expect(prompt).toContain('Good Headlight');
  });
});

describe('buildUserMessage', () => {
  it('formats listing fields into message', () => {
    const listing = {
      id: '123',
      title: 'OEM Headlight',
      price: '$150',
      price_cents: 15000,
      link: 'https://ebay.com/item/123',
      image: 'https://img.ebay.com/123.jpg',
      source: 'ebay',
      external_id: 'ebay-123',
      condition: 'Used',
      listing_date: null,
      location: 'Los Angeles, CA',
      seller_name: 'parts_dealer',
      description: 'OEM headlight assembly, fits 2018 Honda Civic',
    };
    const msg = buildUserMessage(listing);
    expect(msg).toContain('OEM Headlight');
    expect(msg).toContain('$150');
    expect(msg).toContain('Used');
    expect(msg).toContain('Los Angeles, CA');
    expect(msg).toContain('ebay');
  });
});

describe('createGradingChain', () => {
  it('returns a chain with invoke method', () => {
    const chain = createGradingChain();
    expect(chain).toBeDefined();
    expect(typeof chain.invoke).toBe('function');
  });
});
