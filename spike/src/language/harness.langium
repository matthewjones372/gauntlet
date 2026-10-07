grammar Harness

entry Policy:
    'harness' name=STRING
    ('use' packs+=ID (',' packs+=ID)*)?
    ('mode' mode=('shadow' | 'enforce'))?
    (protects+=Protect | zones+=Zone)*;

Protect: 'protect' paths+=STRING (',' paths+=STRING)*;

Zone: 'zone' name=ID '{' ('paths' paths+=STRING (',' paths+=STRING)*)? ('owner' owner=OWNER)? '}';

terminal OWNER: /@[a-zA-Z0-9_\-\/]+/;
terminal ID: /[_a-zA-Z][\w_]*/;
terminal STRING: /"[^"]*"/;
hidden terminal WS: /\s+/;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
