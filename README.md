# Cut the Monolith

A hands-on playground for a class on decomposing a monolith into microservices. Students split
Spring PetClinic's 23 classes into services on their phone and see design and similarity metrics
(validity, CMod, CiD, DTP, DI, BCP, C2C) update live, then score an LLM's answer the same way.

Open it: https://sambuaneesh.github.io/cut-the-monolith/
Class board (project it): https://sambuaneesh.github.io/cut-the-monolith/board.html

The board's store is a small Cloudflare Worker in `worker/`; submissions (a group name and a decomposition)
expire after seven days.

The data (class inventory, dependency graph, reference decomposition, use-case and table labels) is
the Spring PetClinic system from the benchmark of Wang, Bornais and Rubin (ASE 2024).
