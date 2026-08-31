/**
 * Validation for the app registry.
 *
 * Hand-rolled rather than JSON Schema because the two rules that actually
 * matter here are structural, not per-field: `urls` must be a non-empty
 * ORDERED list, and EXACTLY ONE entry must be primary. Both are awkward to
 * express in the JSON Schema Fastify ships with, and both are load-bearing —
 * the order drives reachability probing (docs/DESIGN.md §6.2) and the primary
 * is the fallback when nothing answers.
 */

import { CATEGORIES } from '../db/apps-store.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_URLS = 10;

/** Only these schemes may be stored. `javascript:` in an href is an XSS. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateUrlEntry(entry, index, errors) {
  if (!isPlainObject(entry)) {
    errors.push(`urls[${index}] must be an object`);
    return;
  }

  if (typeof entry.title !== 'string' || !entry.title.trim()) {
    errors.push(`urls[${index}].title is required`);
  } else if (entry.title.length > 60) {
    errors.push(`urls[${index}].title must be 60 characters or fewer`);
  }

  if (typeof entry.url !== 'string' || !entry.url.trim()) {
    errors.push(`urls[${index}].url is required`);
  } else {
    let parsed;
    try {
      parsed = new URL(entry.url);
    } catch {
      errors.push(`urls[${index}].url is not a valid absolute URL`);
      return;
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      errors.push(`urls[${index}].url must be http or https`);
    }
  }

  if (entry.primary !== undefined && typeof entry.primary !== 'boolean') {
    errors.push(`urls[${index}].primary must be a boolean`);
  }
}

/**
 * The `featured` block — what the hero widget renders for an app slide.
 *
 * Optional and nullable: `null` (or absent) means "not featured", which is the
 * state of nearly every app. `cover` is a BARE FILENAME resolved against the
 * data volume, exactly like `icon`, and is rejected if it contains a path
 * separator — a stored value with a `/` in it is a path traversal waiting for
 * somewhere to be joined.
 */
function validateFeatured(featured, errors) {
  if (featured === undefined || featured === null) return;

  if (!isPlainObject(featured)) {
    errors.push('featured must be an object');
    return;
  }

  if (typeof featured.tagline !== 'string' || !featured.tagline.trim()) {
    errors.push('featured.tagline is required');
  } else if (featured.tagline.length > 140) {
    // A hero line, not a paragraph. Long enough for a sentence, short enough
    // that it cannot silently overflow the slide.
    errors.push('featured.tagline must be 140 characters or fewer');
  }

  if (featured.cover !== undefined && featured.cover !== null) {
    if (typeof featured.cover !== 'string') {
      errors.push('featured.cover must be a string');
    } else if (/[/\\]/.test(featured.cover) || featured.cover.includes('..')) {
      errors.push('featured.cover must be a bare filename, not a path');
    }
  }
}

function validateVersion(version, errors) {
  if (version === undefined || version === null) return;

  if (!isPlainObject(version)) {
    errors.push('version must be an object');
    return;
  }

  for (const field of ['latestUrl', 'currentContainerId']) {
    const value = version[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(`version.${field} must be a non-empty string`);
    }
  }

  if (typeof version.latestUrl === 'string' && version.latestUrl.trim()) {
    try {
      const parsed = new URL(version.latestUrl);
      if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        errors.push('version.latestUrl must be http or https');
      }
    } catch {
      errors.push('version.latestUrl is not a valid absolute URL');
    }
  }
}

/**
 * Validates and normalises an app payload.
 *
 * @param {object} body
 * @param {{ requireId?: boolean }} [options]
 * @returns {{ valid: boolean, errors: string[], value?: object }}
 */
export function validateApp(body, { requireId = true } = {}) {
  const errors = [];

  if (!isPlainObject(body)) {
    return { valid: false, errors: ['body must be a JSON object'] };
  }

  if (requireId) {
    if (typeof body.id !== 'string' || !ID_PATTERN.test(body.id)) {
      errors.push('id must be lowercase alphanumeric with hyphens, 1-64 characters');
    }
  }

  if (typeof body.name !== 'string' || !body.name.trim()) {
    errors.push('name is required');
  } else if (body.name.length > 80) {
    errors.push('name must be 80 characters or fewer');
  }

  if (body.description !== undefined && typeof body.description !== 'string') {
    errors.push('description must be a string');
  } else if (typeof body.description === 'string' && body.description.length > 500) {
    errors.push('description must be 500 characters or fewer');
  }

  if (body.category !== undefined && !CATEGORIES.includes(body.category)) {
    errors.push(`category must be one of: ${CATEGORIES.join(', ')}`);
  }

  if (body.icon !== undefined && body.icon !== null) {
    if (typeof body.icon !== 'string') {
      errors.push('icon must be a string');
    } else if (/[/\\]/.test(body.icon) || body.icon.includes('..')) {
      // The icon is a bare filename resolved against the /data volume. A path
      // separator here would let a stored value escape that directory.
      errors.push('icon must be a bare filename, not a path');
    }
  }

  if (!Array.isArray(body.urls) || body.urls.length === 0) {
    errors.push('urls must be a non-empty array, in priority order');
  } else if (body.urls.length > MAX_URLS) {
    errors.push(`urls must contain ${MAX_URLS} entries or fewer`);
  } else {
    body.urls.forEach((entry, index) => validateUrlEntry(entry, index, errors));

    const primaries = body.urls.filter((u) => isPlainObject(u) && u.primary === true).length;
    if (primaries !== 1) {
      errors.push(`exactly one url must be marked primary (found ${primaries})`);
    }
  }

  validateVersion(body.version, errors);
  validateFeatured(body.featured, errors);

  if (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)) {
    errors.push('sortOrder must be an integer');
  }

  // visitCount is server-owned. Reject it rather than ignoring it, so a client
  // sending one is told plainly instead of believing it took effect.
  if (body.visitCount !== undefined) {
    errors.push('visitCount is server-managed and cannot be set');
  }

  if (errors.length) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    value: {
      ...(requireId ? { id: body.id } : {}),
      name: body.name.trim(),
      description: body.description?.trim() ?? '',
      category: body.category ?? 'tools',
      icon: body.icon ?? null,
      // Preserved verbatim, in the order given — this ordering IS the probe
      // priority.
      urls: body.urls.map((u) => ({
        title: u.title.trim(),
        url: u.url.trim(),
        ...(u.primary === true ? { primary: true } : {}),
      })),
      version: body.version ?? null,
      featured: body.featured
        ? {
            tagline: body.featured.tagline.trim(),
            cover: body.featured.cover?.trim() || null,
          }
        : null,
      sortOrder: body.sortOrder ?? 0,
    },
  };
}
