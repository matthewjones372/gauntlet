ThisBuild / scalaVersion := "3.10.0"

lazy val root = (project in file("."))
  .settings(
    name := "calc",
    libraryDependencies += "org.typelevel" %% "weaver-cats" % "0.13.0" % Test,
  )
