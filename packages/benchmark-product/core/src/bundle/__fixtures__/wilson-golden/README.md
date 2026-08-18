# Colophon report

**Complete comparison. No comparative winner is stated.**

Scope: 3 tasks · 2 arms · 1 replicates · self-run.

Report SHA-256: `4444444444444444444444444444444444444444444444444444444444444444`

Matrix SHA-256: `3333333333333333333333333333333333333333333333333333333333333333`

Read the [full report](index.html), [limitations](index.html#limitations), and [portable verification instructions](index.html#verification).

## Prominent adverse facts

- Report limitations: 1; read every limitation below.
- Claim limitations: 1; read every limitation below.

## Configurations

- **baseline** — pinning: {"harness":"harness-a","model":"model-a"}
- **candidate** — pinning: {"harness":"harness-b","model":"model-b"}

## Sealed Matrix accounting

Source: authenticated [`matrix.json`](matrix.json). These stored values are not reconciled with another source.

    {"attrition":{"asymmetryFlags":[],"perArm":{"baseline":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":0,"unjudged":0,"unscorable":0},"candidate":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":1,"unjudged":0,"unscorable":0}}},"completeness":{"expected":6,"floor":"0.5000","judged":6,"runOutcome":"complete"}}

## Sealed Report facts

Source: authenticated [`report.json`](report.json). These stored values are not reconciled with another source.

### Sealed Report arm results

| Arm | n | Pass rate | Wilson low | Wilson high |
|---|---:|---:|---:|---:|
| baseline | 3 | 0.3333 | 0.0615 | 0.7923 |
| candidate | 3 | 0.6667 | 0.2077 | 0.9385 |

### Report method and preregistration

- Report method: jinn.benchmarking.method/wilson @ 1
- Report preregistered: yes
- Report parameters: {"sourceMarker":"shared"}

### Report conflicts

    {"cellKeys":[],"count":0}

### Report disclosures

    {"perSubject":[{"attrition":{"asymmetryFlags":[],"perArm":{"baseline":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":0,"unjudged":0,"unscorable":0},"candidate":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":1,"unjudged":0,"unscorable":0}}},"completeness":{"expected":6,"floor":"0.5000","judged":6,"runOutcome":"complete"},"integrityTiers":{"attested-only":1,"re-derivable":5},"pinning":{"harness":{"match":5,"mismatch":0,"unverifiable":1},"isolation":{"match":3,"mismatch":0,"unverifiable":3},"loadout":{"match":4,"mismatch":0,"unverifiable":2},"model":{"match":6,"mismatch":0,"unverifiable":0}},"subjectSha256":"3333333333333333333333333333333333333333333333333333333333333333"}]}

### Report limitations

- Self-run results do not prove honesty against the run owner.

## Stored Claim facts

Source: authenticated [`claim-package.json`](claim-package.json). These stored values are not reconciled with another source.

### Stored claim mirror

| Arm | n | Pass rate | Wilson low | Wilson high |
|---|---:|---:|---:|---:|
| baseline | 3 | 0.3333 | 0.0615 | 0.7923 |
| candidate | 3 | 0.6667 | 0.2077 | 0.9385 |

### Claim method and preregistration

- Claim method: jinn.benchmarking.method/wilson @ 1
- Claim preregistered: yes
- Claim parameters: {"sourceMarker":"shared"}

### Claim completeness

    {"expected":6,"floor":"0.5000","judged":6,"runOutcome":"complete"}

### Claim attrition

    {"asymmetryFlags":[],"perArm":{"baseline":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":0,"unjudged":0,"unscorable":0},"candidate":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":1,"unjudged":0,"unscorable":0}}}

### Claim conflicts

    {"cellKeys":[],"count":0}

### Claim disclosures

    {"integrityTierCounts":{"attested-only":1,"re-derivable":5},"perSubject":[{"marker":"stored disclosure","subjectSha256":"3333333333333333333333333333333333333333333333333333333333333333"}],"pinningUnverifiableCounts":{"harness":1,"isolation":3,"loadout":2,"model":0}}

### Claim limitations

- Self-run results do not prove honesty against the run owner.

### Claim assurance, rehearsal, and self-run trust boundary

- Assurance: strict-agreement — {"distinctEvaluator":true,"independence":"gating","minVerdicts":2,"verdictRule":"unanimous"}
- Boundary: Distinct evaluator identities prove agent-distinctness, not party-independence.
- Rehearsal: {"previewCount":1,"timestamps":\["2026-08-07T10:00:00.000Z"\]}
- Venue honesty: {"preregistration":"discipline-not-owner-proof","trustBoundary":"workspace-minted public keys; no third-party trust anchor","venue":"self-run"}

## Verification assembly dissent

Source: authenticated [verification assembly](verification/assembly.jsonl).

    {"dissentCellKeys":[]}

## Raw records and catalogs

### Top-level records and catalogs

- [Benchmark record (`benchmark.json`)](benchmark.json)
- [Run record (`run.json`)](run.json)
- [Matrix record (`matrix.json`)](matrix.json)
- [Report payload (`report.json`)](report.json)
- [Report signature envelope (`report-envelope.json`)](report-envelope.json)
- [Claim package (`claim-package.json`)](claim-package.json)
- [Static-bundle projection (`static-bundle.json`)](static-bundle.json)
- [Evidence catalog (`evidence.json`)](evidence.json)
- [Verdict catalog (`verdicts.json`)](verdicts.json)
- [Verification assembly (`verification/assembly.jsonl`)](verification/assembly.jsonl)
- [Public trust material (`trust/public-keys.json`)](trust/public-keys.json)

### Every manifest-listed content-addressed record

- [CAS record `records/6666666666666666666666666666666666666666666666666666666666666666.bin`](records/6666666666666666666666666666666666666666666666666666666666666666.bin)
- [CAS record `records/7777777777777777777777777777777777777777777777777777777777777777.bin`](records/7777777777777777777777777777777777777777777777777777777777777777.bin)

## Portable verification

Copy the complete bundle directory. Reproduce publication with the exact verifier:

    npx @colophon-claims/verify@0.1.0 <bundle-dir>

Use the compatible major line to receive fixes that preserve this bundle-format contract:

    npx @colophon-claims/verify@0.1 <bundle-dir>

The verifier authenticates the manifest, records, evidence graph, Matrix, Report, claim consistency, and every presentation byte using only bundle-carried public trust material. See [index.html#verification](index.html#verification). Built on Jinn.

Typography is embedded for offline use from the SIL Open Font License distributions of Newsreader, Public Sans, and IBM Plex Mono. The complete notices follow so the redistributed font software travels with its license.

## Newsreader font license

```text
Copyright 2020 The Newsreader Project Authors (http://github.com/productiontype/Newsreader) Newsreader-Italic[opsz,wght].ttf: Copyright 2020 The Newsreader Project Authors (http://github.com/productiontype/Newsreader)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## Public Sans font license

```text
Copyright 2015 The Public Sans Project Authors (https://github.com/uswds/public-sans) PublicSans-Italic[wght].ttf: Copyright 2015 The Public Sans Project Authors (https://github.com/uswds/public-sans)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## IBM Plex Mono font license

```text
Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-ThinItalic.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-ExtraLight.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-ExtraLightItalic.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-Light.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-LightItalic.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-Regular.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-Italic.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-Medium.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-MediumItalic.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-SemiBold.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-SemiBoldItalic.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-Bold.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-BoldItalic.ttf: Copyright 2017 IBM Corp. All rights reserved.

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
