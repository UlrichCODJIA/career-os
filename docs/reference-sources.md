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
