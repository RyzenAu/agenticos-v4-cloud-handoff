import type { Metadata } from "next";
import { site } from "@/data/site";
import { AreaMap } from "@/components/art/AreaMap";
import { EnquiryForm } from "@/components/forms/EnquiryForm";
import { Reveal } from "@/components/ui/Reveal";
import { Mail, Phone, Pin } from "@/components/ui/Icons";
import styles from "./contact.module.css";

export const metadata: Metadata = {
  title: "Contact",
  description: "Contact Aldergate's Darling Street office: sales, property management, leasing and general enquiries. Demonstration contact details.",
};

export default function ContactPage() {
  return (
    <div className={`pageTop ${styles.page}`}>
      <div className={`container container--wide ${styles.layout}`}>
        <Reveal className={styles.intro}>
          <p className="eyebrow">Contact</p>
          <h1 className="h-display">
            Tell us what you&rsquo;re <em>trying to do.</em>
          </h1>
          <p className="lede">{site.responseExpectation}</p>

          <dl className={styles.details}>
            <div>
              <dt>
                <Pin /> Office
              </dt>
              <dd>
                {site.office.street}
                <br />
                {site.office.suburb} NSW {site.office.postcode}
              </dd>
            </div>
            <div>
              <dt>
                <Phone /> Phone
              </dt>
              <dd>
                <a href={site.phoneHref}>{site.phone}</a>
              </dd>
            </div>
            <div>
              <dt>
                <Mail /> Email
              </dt>
              <dd>
                <a href={site.emailHref} data-mu-optional="email">{site.email}</a>
              </dd>
            </div>
          </dl>

          <h2 className={`h-3 ${styles.sub}`}>Hours</h2>
          <ul className={styles.hours}>
            {site.hours.map((h) => (
              <li key={h.days}>
                <span>{h.days}</span>
                <span>{h.time}</span>
              </li>
            ))}
          </ul>

          <h2 className={`h-3 ${styles.sub}`}>Departments</h2>
          <ul className={styles.departments}>
            {site.departments.map((d) => (
              <li key={d.key}>
                <b>{d.label}</b>
                <span>{d.blurb}</span>
                <a href={`mailto:${d.email}`} className="link">
                  {d.email}
                </a>
              </li>
            ))}
          </ul>

          <p className={styles.demo}>Agency contact details are drawn from public evidence; missing facts stay unconfirmed. This form is a local demonstration and sends nothing.</p>
        </Reveal>

        <div className={styles.side}>
          <Reveal delay={100}>
            <EnquiryForm
              kind="general"
              fields={[
                { name: "name", label: "Name", required: true, autoComplete: "name", half: true },
                { name: "phone", label: "Phone", type: "tel", autoComplete: "tel", half: true },
                { name: "email", label: "Email", type: "email", required: true, autoComplete: "email" },
                { name: "department", label: "Who should this go to?", type: "select", required: true, options: site.departments.map((d) => d.label) },
                { name: "message", label: "Message", type: "textarea", required: true, rows: 5, placeholder: "What are you trying to do, and what would help?" },
              ]}
            />
          </Reveal>
          <Reveal delay={160} className={styles.map}>
            <AreaMap pin={{ x: site.office.map.x, y: site.office.map.y, label: "the Aldergate office on Darling Street" }} compact />
          </Reveal>
        </div>
      </div>
    </div>
  );
}
