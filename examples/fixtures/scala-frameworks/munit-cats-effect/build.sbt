ThisBuild / scalaVersion := "3.10.0"

lazy val root = (project in file("."))
  .settings(name := "calc", libraryDependencies += "org.typelevel" %% "munit-cats-effect" % "2.2.1" % Test)
