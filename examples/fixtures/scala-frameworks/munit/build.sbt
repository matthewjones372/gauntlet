ThisBuild / scalaVersion := "3.10.0"

lazy val root = (project in file("."))
  .settings(name := "calc", libraryDependencies += "org.scalameta" %% "munit" % "1.3.6" % Test)
