// Gauntlet policy grammar (.gauntlet/policy.gx).
//
// The grammar fixes structure. Vocabulary (modes, units, scopes, review
// conditions, integrity phrases, stack properties, gate and rule names) is
// parsed as plain words and checked by the validator, which gives far better
// errors than a parser's token list. Commas between list items are optional.
//
// A few retired forms (`harness`, `require`, `raise`, `hidden ... from env`)
// still parse so the validator can explain how to migrate them.
grammar Gauntlet

entry Policy:
    header=('gauntlet' | 'harness') name=STRING
    blocks+=Block*;

Block:
    Use | Mode | Owners | Protect | Zone | Arch | Suites | Integrity | Import
    | Budget | Gates | OnFail | Predicate | Review | Stack | Quarantine;

Use:
    'use' packs+=Name (','? packs+=Name)*;

Mode:
    'mode' value=Name;

Owners:
    'owners' owners+=OWNER (','? owners+=OWNER)*;

Protect:
    'protect' (
        globs+=STRING (','? globs+=STRING)*
        | '{' groups+=ProtectGroup* '}'
    );

ProtectGroup:
    name=Name globs+=STRING (','? globs+=STRING)*;

Zone:
    'zone' name=Name '{' items+=ZoneItem* '}';

ZoneItem:
    ZonePaths | ZoneOwner | ZoneRule;

ZonePaths:
    'paths' globs+=STRING (','? globs+=STRING)*;

ZoneOwner:
    'owner' owners+=OWNER (','? owners+=OWNER)*;

ZoneRule:
    'rule' rules+=QName (','? rules+=QName)*;

Arch:
    'arch' '{' rules+=ArchRule* '}';

ArchRule:
    'module' from=Name 'must' 'not' 'depend' 'on' to+=Name (',' to+=Name)* ','?;

Suites:
    'suites' '{' suites+=(HoldoutSuite | TestSuite)* '}';

HoldoutSuite:
    'holdout' name=STRING ('paths' globs+=STRING (','? globs+=STRING)*)? ('ci' ciOnly?='only')? ','?;

TestSuite:
    kind=Name location=STRING ('from' 'env' env=Name)? ','?;

Integrity:
    'integrity' '{' items+=IntegrityItem* '}';

IntegrityItem:
    kind=('ratchet' | 'forbid' | 'flag') phrases+=IntegrityPhrase (','? phrases+=IntegrityPhrase)*;

IntegrityPhrase:
    words+=IntegrityWord+;

Import:
    'import' name=Name '{' items+=ImportItem* '}';

ImportItem:
    ImportCommand | ImportCaution;

ImportCommand:
    'command' command=STRING ','?;

ImportCaution:
    caution?='caution' ','?;

Budget:
    'budget' name=Name '{' items+=BudgetItem* '}';

BudgetItem:
    BudgetCommand | Threshold;

BudgetCommand:
    'command' command=STRING ','?;

Threshold:
    metric=Metric op=Cmp value=Quantity (vsBaseline?='vs' 'baseline')? ','?;

Metric:
    (aggregate=Name '(' field=QName ')') | field=QName;

Gates:
    'gates' '{' tiers+=GateTier* '}';

GateTier:
    name=Name '{' (checks+=Check (','? checks+=Check)*)? '}';

Check:
    BudgetCheck | LlmReviewCheck | MetricCheck;

BudgetCheck:
    'budget' budget=Name;

LlmReviewCheck:
    'llm' 'review' times=Name;

MetricCheck:
    name=CheckName
    (ratchet?='ratchet')?
    (op=Cmp value=Quantity)?
    ('on' scope=Name)?
    ('in' 'zone' zone=Name)?;

OnFail:
    'on' 'fail' gate=CheckName '{' 'fix' fix=STRING ','? '}';

Predicate:
    'predicate' name=Name '=' conditions+=Condition ('and' conditions+=Condition)*;

Review:
    'review' '{' rules+=ReviewRule* '}';

ReviewRule:
    verb=ReviewVerb 'when' conditions+=Condition ('and' conditions+=Condition)* ','?;

ReviewVerb returns string:
    'owner' | 'review' | 'skim' | 'auto' | 'require' | 'raise';

// Conditions have a fixed shape so a predicate ends exactly where the next
// block starts: `[no] [all] <subject> <state>`, `diff <cmp> <amount>`, or the
// name of a predicate.
Condition:
    DiffCondition | FactCondition | PredicateRef;

DiffCondition:
    'diff' op=Cmp value=Quantity;

FactCondition:
    (negated?='no')? (all?='all')? subject=SubjectWord state=StateWord;

PredicateRef:
    name=Name;

SubjectWord returns string:
    ID | 'zone' | 'budget' | 'gates';

StateWord returns string:
    'touched' | 'changed' | 'added' | 'missing' | 'pass';

Stack:
    'stack' '{' items+=StackItem* '}';

Quarantine:
    'quarantine' '{' entries+=QuarantineEntry* '}';

QuarantineEntry:
    test=STRING 'until' until=DATE 'owner' owners+=OWNER (','? owners+=OWNER)* ','?;

StackItem:
    StackLayer | StackLimit | StackReview;

StackLayer:
    'layer' name=Name '{' (props+=LayerProp (','? props+=LayerProp)*)? '}';

LayerProp:
    words+=LayerWord+ ('->' to+=LayerWord+)?;

StackLimit:
    'max' 'layer' 'diff' value=Quantity ','?;

StackReview:
    'review' 'stack' 'when' 'cumulative' op=Cmp tier=LayerWord ','?;

Quantity:
    value=NUMBER unit=Unit?;

Unit returns string:
    ID | '%';

Cmp returns string:
    '<' | '<=' | '>' | '>=' | '==' | '!=';

// Gate checks may be named after a keyword, such as the `arch` gate.
CheckName returns string:
    QName | 'arch' | 'stack' | 'protect' | 'suites' | 'integrity';

QName returns string:
    Name ('.' Name)*;

// User-chosen names. A few keywords that read naturally as names are allowed.
Name returns string:
    ID | 'baseline' | 'env' | 'command' | 'cumulative' | 'caution' | 'ci' | 'only' | 'fix' | 'fail' | 'until'
    | 'changed' | 'all' | 'touched' | 'added' | 'missing' | 'pass';

// Words inside an integrity list. The three list keywords are left out so a
// new `ratchet`, `forbid` or `flag` line starts a new list.
IntegrityWord returns string:
    ID | 'in' | 'on' | 'not' | 'env' | 'from' | 'only' | 'module' | 'baseline' | 'diff' | 'fail' | 'fix'
    | 'changed' | 'all' | 'no' | 'touched' | 'added' | 'missing' | 'pass';

// Words inside a stack layer body, which is closed by '}'.
LayerWord returns string:
    ID | 'zone' | 'budget' | 'gates' | 'paths' | 'rule' | 'module' | 'must' | 'not' | 'depend'
    | 'on' | 'from' | 'env' | 'vs' | 'baseline' | 'ratchet' | 'in' | 'layer' | 'max' | 'diff'
    | 'cumulative' | 'ci' | 'only' | 'caution' | 'fix' | 'fail' | 'flag' | 'forbid' | 'review'
    | 'owner' | 'skim' | 'auto' | 'llm' | 'protect' | 'suites' | 'integrity' | 'arch' | 'stack'
    | 'changed' | 'all' | 'no' | 'touched' | 'added' | 'missing' | 'pass';

// Before NUMBER, so `2026-11-01` lexes as one date.
terminal DATE: /[0-9]{4}-[0-9]{2}-[0-9]{2}/;
terminal NUMBER returns number: /[0-9]+(\.[0-9]+)?/;
terminal OWNER: /@[A-Za-z0-9_.\-]+(\/[A-Za-z0-9_.\-]+)?/;
terminal ID: /[A-Za-z_](?:[A-Za-z0-9_]|-(?=[A-Za-z0-9_]))*/;
terminal STRING: /"(?:\\.|[^"\\\r\n])*"/;

hidden terminal WS: /\s+/;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
