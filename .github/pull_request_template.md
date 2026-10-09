name: Pull request
description: A change to the code, its tests, or its documentation.
title: ""
body:
  - type: markdown
    attributes:
      value: |
        The reason a change exists is more useful to a reviewer than a description of the diff. Every hunk should be explainable by the paragraph below.
  - type: textarea
    id: why
    attributes:
      label: Why
      description: The problem this solves, or the bug it fixes. Link the issue if there is one.
    validations:
      required: true
  - type: textarea
    id: what
    attributes:
      label: What changed
      description: The shape of the change, and any decision that was a trade-off.
    validations:
      required: true
  - type: textarea
    id: risk
    attributes:
      label: What could break
      description: Behaviour that changes for existing users, and anything you could not verify.
    validations:
      required: true
  - type: checkboxes
    id: checks
    attributes:
      label: Checks
      options:
        - label: npm run build --prefix server
        - label: npm test --prefix server
        - label: npm run lint
  - type: textarea
    id: test
    attributes:
      label: What the tests pin
      description: The test added or changed, and what it would catch.
    validations:
      required: false
