/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var EXPORTED_SYMBOLS = [
  "isOwnCalendar",
  "unwrapCalendar",
  "getResolvedCalendarById",
  "getCachedCalendar",
  "isCachedCalendar",
  "convertCalendar",
  "getOccurrenceDate",
  "propsToItem",
  "convertItem",
  "convertAlarm",
];

var { XPCOMUtils } = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetters(this, {
  cal: "resource:///modules/calendar/calUtils.jsm",
  ICAL: "resource:///modules/calendar/Ical.jsm",
  CalEvent: "resource:///modules/CalEvent.jsm",
  CalTodo: "resource:///modules/CalTodo.jsm",
  Services: "resource://gre/modules/Services.jsm",
});

var { ExtensionError } = ChromeUtils.import(
  "resource://gre/modules/ExtensionUtils.jsm"
).ExtensionUtils;
var { splitRecurrenceRules, checkRecurrenceRule } = ChromeUtils.import(
  "resource:///modules/calendar/calRecurrenceUtils.jsm"
);

function isOwnCalendar(calendar, extension) {
  return calendar.superCalendar.type == "ext-" + extension.id;
}

function unwrapCalendar(calendar) {
  let unwrapped = calendar.wrappedJSObject;

  if (unwrapped.mUncachedCalendar) {
    unwrapped = unwrapped.mUncachedCalendar.wrappedJSObject;
  }

  return unwrapped;
}

function getResolvedCalendarById(extension, id) {
  let calendar;
  let calmgr = cal.getCalendarManager();
  if (id.endsWith("#cache")) {
    let cached = calmgr.getCalendarById(id.substring(0, id.length - 6));
    calendar = cached && isOwnCalendar(cached, extension) && cached.wrappedJSObject.mCachedCalendar;
  } else {
    calendar = calmgr.getCalendarById(id);
  }

  if (!calendar) {
    throw new ExtensionError("Invalid calendar: " + id);
  }
  return calendar;
}

function getCachedCalendar(calendar) {
  return calendar.wrappedJSObject.mCachedCalendar || calendar;
}

function isCachedCalendar(id) {
  // TODO make this better
  return id.endsWith("#cache");
}

function convertCalendar(extension, calendar) {
  if (!calendar) {
    return null;
  }

  let props = {
    id: calendar.id,
    type: calendar.type,
    name: calendar.name,
    url: calendar.uri.spec,
    readOnly: calendar.readOnly,
    enabled: !calendar.getProperty("disabled"),
    color: calendar.getProperty("color") || "#A8C2E1",
  };

  if (isOwnCalendar(calendar, extension)) {
    // TODO find a better way to define the cache id
    props.cacheId = calendar.superCalendar.id + "#cache";
    props.capabilities = unwrapCalendar(calendar.superCalendar).capabilities; // TODO needs deep clone?
  }

  return props;
}

function getOccurrenceDate(item, occurrence) {
  if (!occurrence?.occurrenceId && !occurrence?.occurrenceIndex) {
    return null;
  }
  if (!item.recurrenceInfo) {
    throw new ExtensionError("Must be recurring item");
  }
  if (occurrence.occurrenceId) {
    let date = cal.createDateTime(occurrence.occurrenceId).getInTimezone(item.recurrenceStartDate.timezone);
    date.isDate = item.recurrenceStartDate.isDate;
    return date;
  }
  let [[rule]] = splitRecurrenceRules(item.recurrenceInfo);
  let dates = rule.QueryInterface(Ci.calIRecurrenceRule).getOccurrences(item.recurrenceStartDate, item.recurrenceStartDate, null, occurrence.occurrenceIndex);
  if (dates.length < occurrence.occurrenceIndex) {
    throw new ExtensionError("No such occurrence ${occurrence.ocurrencedIndex}");
  }
  return dates.pop();
}

function propsToItem(props, baseItem) {
  let item;
  if (baseItem) {
    item = baseItem;
  } else if (props.type == "event") {
    item = new CalEvent();
    cal.dtz.setDefaultStartEndHour(item);
  } else if (props.type == "task") {
    item = new CalTodo();
    cal.dtz.setDefaultStartEndHour(item);
  } else {
    throw new ExtensionError("Invalid item type: " + props.type);
  }

  if (props.formats?.use == "ical") {
    item.icalString = props.formats.ical;
  } else if (props.formats?.use == "jcal") {
    item.icalString = ICAL.stringify(props.formats.jcal);
  } else {
    if (props.id) {
      item.id = props.id;
    }
    if (props.title) {
      item.title = props.title;
    }
    if (props.description) {
      item.setProperty("description", props.description);
    }
    if (props.location) {
      item.setProperty("location", props.location);
    }
    if (props.categories) {
      item.setCategories(props.categories);
    }
    if (props.priority) {
      item.priority = props.priority;
    }
    if (props.privacy) {
      item.privacy = props.privacy;
    }
    if (props.status) {
      item.status = props.status;
    }
    if (props.transparency) {
      item.setProperty("TRANSP", props.transparency);
    }
    if (props.alarms) {
      const ALARM_RELATED_MAP = {
        absolute: Ci.calIAlarm.ALARM_RELATED_ABSOLUTE,
        start: Ci.calIAlarm.ALARM_RELATED_START,
        end: Ci.calIAlarm.ALARM_RELATED_END,
      };
      item.clearAlarms();
      for (let alarm of props.alarms) {
        if (alarm.related in ALARM_RELATED_MAP) {
          let newAlarm = cal.createAlarm();
          newAlarm.related = ALARM_RELATED_MAP[alarm.related];
          if (alarm.date) {
            newAlarm.alarmDate = cal.createDateTime(alarm.date);
          }
          if (alarm.offset != null) {
            newAlarm.offset = cal.createDuration();
            newAlarm.offset.inSeconds = alarm.offset;
          }
          if (alarm.action) {
            newAlarm.action = alarm.action.toUpperCase();
          }
          item.addAlarm(newAlarm);
        }
      }
    }
    if (props.organizer) {
      let organizer = cal.createAttendee();
      organizer.id = "mailto:" + props.organizer.email;
      organizer.commonName = props.organizer.name;
      organizer.role = "CHAIR";
      organizer.participationStatus = "ACCEPTED";
      organizer.isOrganizer = true;
      item.organizer = organizer;
    }
    if (props.attendees) {
      item.removeAllAttendees();
      for (let attendee of props.attendees) {
        let newAttendee = cal.createAttendee();
        newAttendee.id = "mailto:" + attendee.email;
        newAttendee.commonName = attendee.name;
        newAttendee.role = attendee.role;
        newAttendee.userType = attendee.userType || "INDIVIDUAL";
        newAttendee.participationStatus = attendee.participation;
        item.addAttendee(newAttendee);
      }
    }

    if (props.type == "event") {
      if (props.startDate) {
        item.startDate = cal.createDateTime(props.startDate);
      }
      if (props.startTimezone) {
        item.startDate = item.startDate.getInTimezone(getTimezone(props.startTimezone));
      }
      if (props.endDate) {
        item.endDate = cal.createDateTime(props.endDate);
      }
      if (props.endTimezone) {
        item.endDate = item.endDate.getInTimezone(getTimezone(props.endTimezone));
      }
      if (props.allday) {
        item.startDate.isDate = true;
        item.endDate.isDate = true;
      }
    } else if (props.type == "task") {
      if (props.entryDate != null) {
        item.entryDate = props.entryDate ? cal.createDateTime(props.entryDate) : null;
      }
      if (props.dueDate != null) {
        item.completedDate = props.dueDate ? cal.createDateTime(props.dueDate) : null;
      }
      if (props.completedDate != null) {
        item.completedDate = props.completedDate ? cal.createDateTime(props.completedDate) : null;
      }
      if (props.percentComplete != null) {
        item.percentComplete = props.percentComplete;
      }
      if (props.completed != null) {
        item.isCompleted = props.completed;
      }
      if (props.duration != null) {
        item.duration = props.duration ? cal.createDuration(props.duration) : null;
      }
    }
    // Need to do this after setting the dates.
    if (props.recurrence && !(props.recurrence.type && props.recurrence.interval)) {
      // This item is no longer recurring.
      item.recurrenceInfo = null;
    } else if (props.recurrence) {
      let recurrenceInfo = cal.createRecurrenceInfo();
      recurrenceInfo.item = item;
      let rule = cal.createRecurrenceRule();
      rule.type = props.recurrence.type;
      rule.interval = props.recurrence.interval;
      if (props.recurrence.startDate) {
        rule.startDate = cal.createDateTime(props.recurrence.startDate);
      }
      if (props.recurrence.days) {
        rule.setComponent("BYDAY", props.recurrence.days);
      }
      if (props.recurrence.dayOfMonth) {
        rule.setComponent("BYMONTHDAY", [props.recurrence.dayOfMonth]);
      }
      if (props.recurrence.monthOfYear) {
        rule.setComponent("BYMONTH", [props.recurrence.monthOfYear]);
      }
      if (props.recurrence.count) {
        rule.count = props.recurrence.count;
      } else if (props.recurrence.untilDate) {
        let date = cal.createDateTime(props.recurrence.untilDate);
        if (item.recurrenceStartDate.isDate) {
          rule.untilDate = date;
        } else {
          // Provide the time if the extension didn't
          let time = item.recurrenceStartDate.clone();
          time.year = date.year;
          time.month = date.month;
          time.day = date.day;
          rule.untilDate = time;
        }
      }
      recurrenceInfo.insertRecurrenceItemAt(rule, 0);
      if (props.recurrence.deletedIds) {
        for (let occurrence of props.recurrence.deletedIds) {
          let recurrenceId = cal.createDateTime(occurrence).getInTimezone(item.recurrenceStartDate.timezone);
          recurrenceId.isDate = item.recurrenceStartDate.isDate;
          recurrenceInfo.removeOccurrenceAt(recurrenceId);
        }
      } else if (props.recurrence.deletedIndices) {
        let lastIndex = Math.max(...props.recurrence.deletedIndices);
        let dates = rule.getOccurrences(item.recurrenceStartDate, item.recurrenceStartDate, null, lastIndex);
        if (dates.length < lastIndex) {
          throw new ExtensionError("Recurrence only has (${dates.length}) occurrences");
        }
        for (let index of props.recurrence.deletedIndices) {
          recurrenceInfo.removeOccurrenceAt(dates[index - 1]);
        }
      }
      item.recurrenceInfo = recurrenceInfo;
      if (props.recurrence.exceptions) {
        for (let exception of props.recurrence.exceptions) {
          let occurrence = recurrenceInfo.getOccurrenceFor(getOccurrenceDate(item, exception));
          exception.type = props.type;
          propsToItem(exception, occurrence);
          recurrenceInfo.modifyException(occurrence, true);
        }
      }
    }
    if (props.created != null) {
      item.setProperty("CREATED", props.created ? cal.createDateTime(props.created) : null);
    }
    if (props.dtstamp != null) {
      item.setProperty("DTSTAMP", props.dtstamp ? cal.createDateTime(props.dtstamp) : null);
    }
    if (props.lastModified != null) {
      item.setProperty("LAST-MODIFIED", props.lastModified ? cal.createDateTime(props.lastModified) : null);
    }
  }
  return item;
}

function getTimezone(aDisplayName) {
  let timezone = cal.getTimezoneService().getTimezone(aDisplayName);
  if (timezone) {
    return timezone;
  }
  // Create a fake event and parse a time zone from it.
  let comp = cal.getIcsService().parseICS("BEGIN:VCALENDAR\nBEGIN:VTIMEZONE\nTZID:" + aDisplayName.replace(/[^ -~]/g, "") + "\nEND:VTIMEZONE\nEND:VCALENDAR", null);
  return {
    provider: null,
    icalComponent: comp.getFirstSubcomponent("VTIMEZONE"),
    tzid: aDisplayName,
    isUTC: false,
    isFloating: false,
    latitude: null,
    longitude: null,
    displayName: aDisplayName,
    toString() { return this.displayName; },
  };
}

function convertItem(item, options, extension) {
  if (!item) {
    return null;
  }

  let props = {};

  if (item instanceof Ci.calIEvent) {
    props.type = "event";
  } else if (item instanceof Ci.calITodo) {
    props.type = "task";
  }

  props.id = item.id;
  props.calendarId = item.calendar.superCalendar.id;
  props.title = item.title || "";
  props.description = item.getProperty("description") || "";
  props.location = item.getProperty("location") || "";
  props.categories = item.getCategories();
  props.priority = item.priority;
  props.privacy = item.privacy;
  props.status = item.status;
  props.transparency = item.getProperty("TRANSP") || "";
  props.created = item.getProperty("CREATED")?.icalString || "";
  props.dtstamp = item.getProperty("DTSTAMP")?.icalString || "";
  props.lastModified = item.getProperty("LAST-MODIFIED")?.icalString || "";
  props.alarms = item.getAlarms().map(alarm => convertAlarm(item, alarm));
  props.organizer = item.organizer && convertAttendee(item.organizer);
  props.attendees = item.getAttendees().map(convertAttendee);
  if (item.recurrenceId) {
    let [[rule]] = splitRecurrenceRules(item.parentItem.recurrenceInfo);
    if (rule instanceof Ci.calIRecurrenceRule) {
      props.occurrenceIndex = rule.getOccurrences(item.parentItem.recurrenceStartDate, item.parentItem.recurrenceStartDate, item.recurrenceId, 0).length + 1;
    }
    props.occurrenceId = item.recurrenceId.icalString;
  } else if (item.recurrenceInfo) {
    let [[rule], deletions] = splitRecurrenceRules(item.recurrenceInfo);
    if (rule instanceof Ci.calIRecurrenceRule) {
      props.recurrence = {};
      props.recurrence.type = rule.type;
      props.recurrence.startDate = item.recurrenceStartDate.icalString;
      props.recurrence.interval = rule.interval;
      props.recurrence.firstDayOfWeek = Services.prefs.getIntPref("calendar.week.start", 0) + 1;
      if (checkRecurrenceRule(rule, ["BYDAY"])) {
        props.recurrence.days = rule.getComponent("BYDAY");
      }
      if (checkRecurrenceRule(rule, ["BYMONTHDAY"])) {
        props.recurrence.dayOfMonth = rule.getComponent("BYMONTHDAY")[0];
      }
      if (checkRecurrenceRule(rule, ["BYMONTH"])) {
        props.recurrence.monthOfYear = rule.getComponent("BYMONTH")[0];
      }
      if (rule.isByCount) {
        props.recurrence.count = rule.count;
      } else if (rule.untilDate) {
        props.recurrence.untilDate = rule.untilDate.getInTimezone(item.recurrenceStartDate.timezone).icalString;
      }
      if (deletions.length) {
        let maxDate = item.recurrenceStartDate;
        for (let deletion of deletions) {
          let date = deletion.QueryInterface(Ci.calIRecurrenceDate).date;
          if (maxDate.compare(date) < 0) {
            maxDate = deletion.date;
          }
        }
        let occurrences = rule.getOccurrences(item.recurrenceStartDate, item.recurrenceStartDate, maxDate, 0);
        occurrences.push(maxDate);
        props.recurrence.deletedIndices = deletions.map(deletion => occurrences.findIndex(date => !date.compare(deletion.date)) + 1);
        props.recurrence.deletedIds = deletions.map(deletion => deletion.date.icalString);
      }
      props.recurrence.exceptions = item.recurrenceInfo.getExceptionIds().map(id => {
        let exception = convertItem(item.recurrenceInfo.getExceptionFor(id));
        delete exception.type;
        delete exception.id;
        delete exception.calendarId;
        return exception;
      });
    }
  }

  if (extension && isOwnCalendar(item.calendar, extension)) {
    props.metadata = {};
    let cache = getCachedCalendar(item.calendar);
    try {
      // TODO This is a sync operation. Not great. Can we optimize this?
      props.metadata = JSON.parse(cache.getMetaData(item.id)) ?? {};
    } catch (e) {
      // Ignore json parse errors
    }
  }

  if (options?.returnFormat) {
    props.formats = { use: null };
    let formats = options.returnFormat;
    if (!Array.isArray(formats)) {
      formats = [formats];
    }

    for (let format of formats) {
      switch (format) {
        case "ical":
          props.formats.ical = item.icalString;
          break;
        case "jcal":
          // TODO shortcut when using icaljs backend
          props.formats.jcal = ICAL.parse(item.icalString);
          break;
        default:
          throw new ExtensionError("Invalid format specified: " + format);
      }
    }
  }

  if (props.type == "event") {
    props.startDate = item.startDate.icalString;
    props.startTimezone = item.startDate.timezone.tzid;
    props.endDate = item.endDate.icalString;
    props.endTimezone = item.endDate.timezone.tzid;
    if (!item.calendar.getProperty("capabilities.timezones.floating.supported")) {
      if (item.startDate.timezone.isFloating) {
        props.startTimezone = cal.dtz.defaultTimezone.tzid;
      }
      if (item.endDate.timezone.isFloating) {
        props.endTimezone = cal.dtz.defaultTimezone.tzid;
      }
    }
    props.allday = item.startDate.isDate;
  } else if (props.type == "task") {
    props.entryDate = item.entryDate?.icalString || "";
    props.dueDate = item.dueDate?.icalString || "";
    props.completedDate = item.completedDate?.icalString || "";
    props.percentComplete = item.percentComplete;
    props.completed = item.isCompleted;
    props.duration = item.duration?.icalString || "";
  }

  return props;
}

function convertAttendee(attendee) {
  return {
    role: attendee.role,
    userType: attendee.userType,
    name: attendee.commonName,
    email: attendee.id.replace(/^mailto:/, ""),
    participation: attendee.participationStatus,
  };
}

function convertAlarm(item, alarm) {
  const ALARM_RELATED_MAP = {
    [Ci.calIAlarm.ALARM_RELATED_ABSOLUTE]: "absolute",
    [Ci.calIAlarm.ALARM_RELATED_START]: "start",
    [Ci.calIAlarm.ALARM_RELATED_END]: "end",
  };

  return {
    itemId: item.id,
    action: alarm.action.toLowerCase(),
    date: alarm.alarmDate?.icalString,
    offset: alarm.offset?.inSeconds,
    related: ALARM_RELATED_MAP[alarm.related],
  };
}
