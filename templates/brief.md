# Brief

## Question
What do we want to learn? One paragraph.

## Baseline
The exact configuration or checkpoint every result is compared against (path, commit, hash).

## Evaluation
How results are judged: metric, data split, number of samples and seeds, and what difference would matter.
If an evaluator is pinned in campaign.json, say which script produces the headline numbers.

## Budget and deadline
Up to N simultaneous GPUs; deadline as in campaign.json. No other limits unless written here.

## Plan (optional)
Priorities and expected outcomes, in order. Write predictions and preferences ("if the cheap probe loses, prefer arm
B"), not go/no-go gates: the worker decides when to spend the budget, and a step that turns out to be impossible must
not leave the campaign idle.

## Constraints and context
Anything the worker must know: data locations, known pitfalls, what is out of scope.
