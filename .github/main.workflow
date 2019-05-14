workflow "Continuous Testing" {
  on = "push"
  resolves = [
    "Typecheck",
  ]
}

action "Install Dependencies" {
  uses = "actions/npm@v2.0.0"
  args = "install"
}

action "Typecheck" {
  uses = "actions/npm@v2.0.0"
  needs = ["Install Dependencies"]
  args = "run type-check"
}
