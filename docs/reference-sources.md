# Reference Sources and Provenance

The initial Career OS repository is clean-room product scaffolding. Legacy repositories are evidence and migration inputs, not dependencies.

| Reference                                                                                         | Pinned revision                            | Permitted role                                                                          | Prohibited role                                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`UlrichCODJIA/ai-job-search-dashboard`](https://github.com/UlrichCODJIA/ai-job-search-dashboard) | `c4982d87b0b64e87a4f190c1bb933fb565a81309` | UI screenshots, API/run-stream contract evidence, security lessons, reviewed fixtures   | Workspace dependency, submodule, symlink, runtime checkout, canonical authority |
| [`MadsLorentzen/ai-job-search`](https://github.com/MadsLorentzen/ai-job-search)                   | `d82df2fe5182c172070eeaa4259af6f21cfda64f` | Workflow methodology, prompt/evaluation behavior, import/export and regression evidence | Product core, implicit license grant, runtime checkout, canonical authority     |

Before copying or adapting any code or fixture, record:

1. source repository, path, and immutable revision;
2. original license and compatibility conclusion;
3. behavior being preserved and assumptions being removed;
4. destination owner and dependency direction;
5. contract/regression tests;
6. security and privacy review.

No legacy source code has been copied. DSV-002 adds only synthetic compatibility fixtures derived from the reviewed public type shapes above; their provenance and limits are recorded beside the fixtures.

## Pilot discovery leads

The following sources may contribute untrusted candidate tenant slugs to a private pilot manifest. They are not employer-ownership evidence, canonical company identity, or permission to redistribute job descriptions. Every promoted row still requires a current employer-domain page linking to the exact ATS tenant, live connector validation, policy review, and an operator decision.

| Reference | Reviewed revision | License / role |
| --- | --- | --- |
| [`edwarddgao/openapply`](https://github.com/edwarddgao/openapply) | `861a860ccc658025bc980a5d7c2838ee337c3344` | MIT; Common Crawl-derived Greenhouse/Lever/Ashby tenant leads and reproducible collection methodology |
| [`mherzog4/job-boards`](https://github.com/mherzog4/job-boards) | `da7885cff552c513319318f2f31ed23f049f426e` | MIT; independent public-board discovery and validation methodology |
| [`Feashliaa/job-board-aggregator`](https://github.com/Feashliaa/job-board-aggregator) | `2868be69e1bd0cb8e46884b5d956454f452ea405` | AGPL-3.0; tenant leads only, retained outside Git with source attribution |
| [`trylynceus/jobs`](https://github.com/trylynceus/jobs) | `0e4f470f582b6dadbf92cae23c6774f1267cbd67` | MIT; aggregate company-name cross-checks only, never ownership evidence |

The private manifest records its exact dataset URL, license, generation and review times, reviewer, per-row discovery reference, evidence URL, and observation time. The release record contains only aggregate counts and its SHA-256 digest.
