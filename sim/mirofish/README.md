# MiroFish on Vantage, cradle to grave

[MiroFish](https://github.com/666ghj/MiroFish) (AGPL-3.0) is a multi-agent simulation engine. It reads seed material into a knowledge graph, turns the people in it into agents with personas and memory, and lets them interact on simulated Twitter- and Reddit-like feeds. A report agent then writes a prediction.

Here it is pointed at Vantage for a whole enlistment: arrival, daily work, leading, the Record and JEPES, promotion and FITREP, transfer, separation and records disposition. The agents are the synthetic section in `seed/vantage-lifecycle.md`: three junior Marines, two NCOs, a Sgt, the SNCOIC, the OIC, the reviewing officer, the S-1 chief, the ISSM and the system owner.

MiroFish is not part of Vantage, and nothing here is built into it.

## What is sent where

The seed, the requirement and the interview questions go to the LLM provider and to Zep Cloud. They hold:
- public product facts;
- synthetic people.

They hold no Vantage data and nothing from a real deployment. Keep it that way: never add exports, logs or real names to `seed/`.

## Run it

1. **Keys.** Put the keys in the cloud environment's settings as environment variables (never in a file here):
   - `LLM_API_KEY`;
   - `ZEP_API_KEY`;
   - optionally `LLM_BASE_URL` and `LLM_MODEL_NAME`, for any OpenAI-compatible provider (MiroFish defaults to OpenAI with `gpt-4o-mini`).

   Start a new session so they are loaded.
2. **MiroFish.** The runner fetches it into `/home/user/666ghj/mirofish` (or `$MIROFISH_DIR`) and installs its backend with `uv` the first time; that needs Python 3.11 or 3.12 and a few minutes.
3. **Run.**
   ```bash
   python3 sim/mirofish/run.py --rounds 20
   ```
   The script starts MiroFish's backend and works through seven steps:
   1. ontology;
   2. knowledge graph;
   3. personas;
   4. simulation;
   5. one interview question per lifecycle stage, asked of every agent;
   6. MiroFish's report;
   7. `summary.md`.

   It asks for English output, and everything lands in `sim/mirofish/runs/<time>/`. Start with a short run: MiroFish's own advice is under 40 rounds at first, because a run spends tokens on every agent every round.

`--no-start --base URL` uses a backend you already run. `--platform reddit` halves the cost. `--skip-interviews` stops after the simulation.

## Reading the result

The simulation predicts what people would say and do. It does not observe Vantage. Check every finding against the product before acting on it. `tests/server/lifecycle.test.ts` walks one Marine through the same eight stages in the real application, and is the ground truth to check claims against. A finding that the test contradicts is the simulation's error; a finding it cannot settle is a question for real users.

## Files

- `seed/vantage-lifecycle.md`: the seed (the product, the section, the eight stages, known limits).
- `requirement.txt`: what MiroFish is asked to predict.
- `interviews.json`: one question per stage, asked of every agent after the run.
- `run.py`: the runner. Standard library only.
