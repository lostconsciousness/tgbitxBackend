\# Code Review Instructions



Focus on:

\- Security issues

\- Secret leakage

\- Incorrect network selection

\- Mainnet/testnet confusion

\- Withdrawal double-spend or duplicate broadcast risks

\- Missing idempotency

\- Missing balance checks

\- Missing confirmation handling

\- Race conditions around hot wallet funds

\- Incorrect decimal handling for tokens

\- Unsafe logging

\- Missing validation of addresses, amounts, and network IDs



For every finding, include:

\- severity: low / medium / high / critical

\- affected file/function

\- why it matters

\- minimal fix

