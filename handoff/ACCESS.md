# Dot's access to the running app

Dot reaches AgenticOS only through the reviewed gateway, with its own revocable identity. The raw Ryzen hub stays private
to the tailnet, and native account credentials stay on the hub.

The gateway URL, enrolment route, granted capabilities, capability matrix and reconnect/renewal steps are published here
in a follow-up commit when the gateway's single review completes. Until that commit exists, access is **not** complete
and must not be described as complete.

The enrolment code is minted by the owner on the hub console and handed to Dot directly. It never appears in this
repository, in chat or in logs.
