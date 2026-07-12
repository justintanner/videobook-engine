import fc from 'fast-check';

// --- Path traversal arbitraries ---

export const pathTraversalArb = fc.oneof(
  fc.constant('../'),
  fc.constant('../../'),
  fc.constant('../../../etc/passwd'),
  fc.constant('..\\..\\etc\\passwd'),
  fc.constant('/etc/passwd'),
  fc.constant('/tmp/evil'),
  fc.constant('foo/../../../etc'),
  fc.constant('foo/../../bar'),
  fc.constant('\0'),
  fc.constant('foo\0bar'),
  fc.constant('..\0.'),
);

// --- Dangerous filename arbitrary ---

export const dangerousFilenameArb = fc.oneof(
  pathTraversalArb,
  fc.constant('.'),
  fc.constant('..'),
  fc.constant(''),
  fc.constant('.git/config'),
  fc.constant('.git/HEAD'),
  fc.constant('a'.repeat(256)),
  fc.constant('file\nname'),
  fc.constant('file\rname'),
  fc.string({ minLength: 1, maxLength: 10 }).map(s => `../` + s),
);

// --- Dangerous slug arbitrary ---

export const dangerousSlugArb = fc.oneof(
  pathTraversalArb,
  fc.constant('.hidden'),
  fc.constant('-leading-dash'),
  fc.constant('UPPERCASE'),
  fc.constant('has spaces'),
  fc.constant('has\nnewline'),
  fc.constant('has\ttab'),
  fc.constant(''),
  fc.constant('   '),
  fc.constant('.'),
  fc.constant('..'),
  fc.constant('.git'),
);

// --- Dangerous prefix arbitrary ---

export const dangerousPrefixArb = fc.oneof(
  pathTraversalArb,
  fc.constant(''),
  fc.constant('unknown'),
  fc.constant('VID'),
  fc.constant('IMG'),
  fc.constant('vid'),    // missing trailing hyphen
  fc.constant('img'),
  fc.constant('  '),
  fc.constant('vid-'),   // valid
  fc.constant('script'), // missing trailing hyphen
);

// --- Dangerous asset ID arbitrary ---

export const dangerousAssetIdArb = fc.oneof(
  fc.constant('vid-../../other'),
  fc.constant('../../../etc'),
  fc.constant(''),
  fc.constant('.git'),
  fc.constant('.git/config'),
  fc.constant('vid-\0test'),
  fc.constant('/vid-test'),
  fc.constant('vid-test/../../../etc'),
);

// --- Commit message injection arbitrary ---

export const commitMessageInjectionArb = fc.oneof(
  fc.constant('normal message'),
  fc.constant('msg|with|pipes'),
  fc.constant('msg\nwith\nnewlines'),
  fc.constant('msg\0with\0nulls'),
  fc.constant('a'.repeat(10000)),
  fc.constant('msg\rwith\rcarriage'),
  fc.constant('$(echo pwned)'),
  fc.constant('`echo pwned`'),
  fc.constant("'; DROP TABLE commits; --"),
);

// --- Valid prefix arbitrary ---

export const validPrefixArb = fc.constantFrom('vid', 'img', 'aud', 'script', 'char', 'nb');

// --- Safe asset name arbitrary ---

export const safeAssetNameArb = fc.array(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ' ', '-',
  ),
  { minLength: 1, maxLength: 30 },
).map(chars => chars.join(''));
