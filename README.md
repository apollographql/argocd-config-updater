# ArgoCD Config Updater

This action can be used inside a GitHub workflow to update YAML config files
based on external events. Specifically, these are config files for Apollo's
particular use of ArgoCD. We use an `apollo-application` Helm chart to define
the ArgoCD Applications in our environment. This action knows how to make
several kinds of updates to the application configuration.

Specifically, if our repository has a chart with this Chart.yaml:

```yaml
apiVersion: v2
name: some-app
description: some-app installations
type: application
version: 0.1.0

dependencies:
  - name: apollo-application
    version: '>= 0.1.0'
    repository: https://some.repository.example/apollo-application
    alias: dev
  - name: apollo-application
    version: '>= 0.1.0'
    repository: https://some.repository.example/apollo-application
    alias: staging
  - name: apollo-application
    version: '>= 0.1.0'
    repository: https://some.repository.example/apollo-application
    alias: prod
```

and this values.yaml:

```yaml
global:
  gitConfig:
    repoURL: https://github.com/some-org/some-repository-of-charts.git
    path: charts/some-app
  dockerImage:
    repository: some-app

dev:
  gitConfig:
    trackMutableRef: main
    ref: c8e6a2a5ee0fa3950d190c835f4190f19e321f92
  dockerImage:
    trackMutableTag: main
    tag: main---0000123-abcd0123

staging:
  promote:
    from: dev
  gitConfig:
    ref: c8e6a2a5ee0fa3950d190c835f4190f19e321f92
  dockerImage:
    tag: main---0000100-cbcd0123

prod:
  promote:
    from: staging
  gitConfig:
    ref: c8e6a2a5ee0fa3950d190c835f4190f19e321f92
  dockerImage:
    tag: main---0000100-cbcd0123
```

`apollo-application` is a chart that uses the `gitConfig` and `dockerImage`
configuration to generate an ArgoCD Application resource.

Running this action can do three different things, depending on which inputs are
provided. You must provide the `files` input, which is a glob pattern for which
files to update.

## Updating git refs

For each top-level section with a `gitConfig` block, if the `gitConfig` block
contains the keys `repoURL`, `path`, `trackMutableRef` and `ref`, then this
action can update the value at `ref` to be equal to the current git SHA for the
ref named by `trackMutableRef` in the repository named by `repoURL`. (The
`repoURL` and `path` keys may also be found in a `gitConfig` block under the
top-level `global` block.)

If the value at `ref` is already a git commit SHA, and the subtree named by
`path` is identical at the commit it names and the commit named by
`trackMutableRef` (based on comparing tree SHAs), it will not change the value.
This means that changes to other parts of the repository will not result in
"no-op" changes to this line.

The effect of using `trackMutableRef` is similar to just specifying the mutable
ref directly as the ref which the ArgoCD application tracks. But by explicitly
changing the config file for each update, you can clearly see the difference
between different environments, including environments that are not updated
automatically in this way. Then, `promote` blocks (see below) can copy the git
SHA to another application which does not use `trackMutableRef`.

This functionality uses the GitHub API, which requires a GitHub API token to be
passed via the `github-token` input. This token needs to have read access to
code and metadata in all repositories that are referenced by `repoURL`.

## Updating Docker tags

For each top-level section with a `dockerImage` block, if the `dockerImage`
block contains the keys `repository`, `trackMutableTag` and `tag`, then this
action can update the value at `tag` to be equal to an "immutable" tag which
points at the same image version as the tag named in `trackMutableTag` for the
image named by `repository`. (The `repository` key may also be found in a
`dockerImage` block under the top-level `global` block.)

Specifically, this automation treats as immutable any tag starting with the
value of `trackMutableTag` followed by `---`. The assumption is that a build
process creates these immutable tags and also updates the shorter mutable tag.

This specifically works with Docker images hosted at Google Artifact Registry.
All docker images must be in the same AR registry, named by the
`update-docker-tags-for-artifact-registry-repository` input, which has the form
`projects/PROJECT/locations/LOCATION/repositories/REPOSITORY`.

(Naming is a bit confusing here, because Docker uses the word "repository" to
mean "a bunch of similar images that have different versions and tags", and
Artifact Registry uses the word "repository" to mean "a collection of Docker
repositories and other kinds of packages". The repository named in the action
input is an AR repository; the repository named in the `dockerImage` section is
a Docker repository (ie, image name).)

If the value at `tag` already points at the same image version as the value at
`trackMutableTag` (and it starts with the `trackMutableTag` value and `---`)
then it is left alone. Otherwise, it is set to the tag pointing at the same
version as `trackMutableTag` of the `TAG---*` format which comes
lexicographically first.

Like with `trackMutableRef`, this is helpful for making something which can be
"promoted", but in addition, pointing Kubernetes containers at mutable Docker
tags isn't very helpful because deployments will not restart just because the
tag points at a new image. This mechanism means that changes to the mutable tag
will actually lead to rollouts.

This functionality uses the Google Cloud Platform API, which requires read
access to the Artifact Registry repository in question (specifically, the
`artifactregistry.tags.get` and `artifactregistry.versions.get` permissions).
You should run the `google-github-actions/auth` action before this one.

## Promoting values between apps

Top-level sections can have a `promote` block with a `from` key naming a
different top-level section. If the action is run with `update-promoted-values`
set (and, if provided, `promotion-target-regexp` matches the section's name),
then the automation will copy values from the other block to the target block.
By default, the copied values are `gitConfig.ref` and `dockerImage.tag`; you can
specify a different set of paths via `promote.yamlPaths`. This is applied after
updating mutable refs and tags.

# Caveat

This package is designed specifically to meet the needs of Apollo's ArgoCD
installation. We are making it publicly available under the MIT license to serve
as an example/starting point for other organizations with similar needs, but we
do not intend to generalize it in ways that are not relevant to our
installation, or to provide any support.
