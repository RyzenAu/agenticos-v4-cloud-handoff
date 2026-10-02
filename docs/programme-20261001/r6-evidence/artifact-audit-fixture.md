# Website audit: the local demo clinic fixture (synthetic)

**Read-only.** Pages were opened, measured and photographed at a desktop and a phone width. Nothing was clicked, typed, filled in or submitted, and nobody was logged in.

## At a glance
- 2 to fix first, 3 that should be fixed, 2 minor.
- 4 page views measured (home on desktop, home on phone, services on phone, contact on phone); 3 links checked, 1 broken.

## Findings, most important first

### 1. P1: No mobile viewport setting
*Fix first: a visitor is blocked or misled. Seen on the home page, phone.*

The page has no viewport setting, so a phone lays it out 1148 px wide instead of 390 px and shrinks everything.

![home on phone](shot-home-phone.jpg)

### 2. P1: Broken link: "Book a visit"
*Fix first: a visitor is blocked or misled. Seen on the home page.*

On home, this link goes to book.html, which answers HTTP 404 (no such file). A visitor following it reaches a dead end.

### 3. P2: 1 image has no alt text
*Should fix: a visitor is made to work harder. Seen on the home page, desktop and phone.*

A screen reader announces these as an unnamed image, and they are blank if the picture does not load.

![home on desktop and phone](shot-home-desktop.jpg)

### 4. P2: Tap targets are too small for a thumb
*Should fix: a visitor is made to work harder. Seen on the home page, phone.*

3 of 4 tappable items are under 32 px on their smaller side (Services (38x14); Contact (36x14); Book a visit (53x14)).

![home on phone](shot-home-phone.jpg)

### 5. P2: 3 form fields have no label
*Should fix: a visitor is made to work harder. Seen on the contact page, phone.*

3 of 3 fields rely on placeholder text alone, which disappears when typing and is not read as a label. (The form was not filled or submitted.)

![contact on phone](shot-contact-phone.jpg)

### 6. P3: Some text is too small to read comfortably
*Minor. Seen on the home page, desktop and phone.*

The smallest text is 10 px; 3 of 8 text blocks are under 12 px.

![home on desktop and phone](shot-home-desktop.jpg)

### 7. P3: A few tap targets are small
*Minor. Seen on the contact page, phone.*

1 tappable item is under 32 px (Home (46x22)).

![contact on phone](shot-contact-phone.jpg)

## Screenshots
**home, desktop (1280 px)**

![home desktop](shot-home-desktop.jpg)

**home, phone (390 px)**

![home phone](shot-home-phone.jpg)

**services, phone (390 px)**

![services phone](shot-services-phone.jpg)

**contact, phone (390 px)**

![contact phone](shot-contact-phone.jpg)

## Links checked

| From | Link | Goes to | Result |
| --- | --- | --- | --- |
| home | Services | services.html | OK: HTTP 200 |
| home | Contact | contact.html | OK: HTTP 200 |
| home | Book a visit | book.html | BROKEN: HTTP 404 |

## Not checked
- Colour contrast and keyboard order (they need a different read).
- Speed under a slow connection.
- Anything behind a login, and what happens after a form is submitted (forms are never submitted).